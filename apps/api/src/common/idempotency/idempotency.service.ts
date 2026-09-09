import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import type { Env } from '../../config/env.schema';
import { requireTenantId } from '@tp/tenancy';
import { noteIdempotencyClaim } from '../request-scope';

export type IdempotencyOutcome<T> =
  | { kind: 'fresh'; complete: (result: T) => Promise<void>; abandon: () => Promise<void> }
  | { kind: 'replayed'; result: T };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Claims an idempotency key, or returns the stored result of a previous
   * completed attempt.
   *
   * The claim is an INSERT against a unique `(scope, key)` index. That insert
   * either succeeds or raises P2002; there is no read-then-write window for two
   * concurrent retries to slip through. Checking for an existing row first and
   * inserting afterwards would reintroduce exactly the race this prevents.
   *
   * The claim commits on its own, deliberately outside the caller's
   * transaction: rolled back alongside a failed order, it would let a retry
   * execute again instead of being told what happened.
   */
  async claim<T>(scope: string, key: string, requestBody: unknown): Promise<IdempotencyOutcome<T>> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestBody ?? null))
      .digest('hex');
    const expiresAt = new Date(
      Date.now() + this.config.getOrThrow('IDEMPOTENCY_KEY_TTL_SECONDS', { infer: true }) * 1000,
    );

    try {
      const claimed = await this.prisma.idempotencyKey.create({
        data: {
          tenantId: requireTenantId(),
          scope,
          key,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt,
        },
      });
      return this.fresh<T>(claimed.id);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { tenantId_scope_key: { tenantId: requireTenantId(), scope, key } },
    });
    if (existing === null) {
      // The row vanished between the failed insert and this read — another
      // attempt abandoned it. Treat it as a live conflict rather than guessing.
      throw new DomainError(
        TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'A request with this Idempotency-Key is already being processed',
      );
    }

    if (existing.requestHash !== requestHash) {
      // Same key, different body. Serving the cached response would answer a
      // question the client did not ask.
      throw new DomainError(
        TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'This Idempotency-Key was already used with a different request body',
        { key },
      );
    }

    if (existing.status === 'COMPLETED' && existing.responseBody !== null) {
      return { kind: 'replayed', result: existing.responseBody as T };
    }

    if (existing.status === 'COMMITTED') {
      /**
       * The effects exist — the transaction marked the claim as it committed —
       * but the result was never recorded, because the process died in the
       * few milliseconds between. Running the operation again would double it;
       * answering from a result that was never written is impossible. So the
       * client is told, in a code it can act on, to read the account.
       */
      throw new DomainError(
        TradingErrorCode.IDEMPOTENCY_RESULT_UNAVAILABLE,
        'This request was already applied, but its result was not recorded. Do not retry with a new key — read the account to see the effect.',
        { key },
      );
    }

    /**
     * IN_PROGRESS. Either another attempt is running now, or one died before
     * it committed anything — and the two are told apart by age. A live
     * request cannot outlast the takeover window (it is bounded by the
     * transaction budget many times over), so a claim older than that with
     * nothing committed is a claim nobody is going to finish. The retry takes
     * it over, atomically: the conditional update succeeds for exactly one
     * contender.
     *
     * Without this, a crash before commit blocked every retry with the same key
     * for the key's whole lifetime — a day — and the client's only way forward
     * was a fresh key, which is the one thing the design asks them never to do.
     */
    const takeoverAfterMs = this.config.getOrThrow('IDEMPOTENCY_TAKEOVER_AFTER_MS', { infer: true });
    const cutoff = new Date(Date.now() - takeoverAfterMs);
    if (existing.status === 'IN_PROGRESS' && existing.createdAt < cutoff) {
      const taken = await this.prisma.idempotencyKey.updateMany({
        where: { id: existing.id, status: 'IN_PROGRESS', createdAt: { lt: cutoff } },
        data: { createdAt: new Date(), expiresAt },
      });
      if (taken.count === 1) {
        this.logger.warn(
          { scope, claimId: existing.id },
          'An idempotency claim abandoned by a crash was taken over by a retry',
        );
        return this.fresh<T>(existing.id);
      }
    }

    throw new DomainError(
      TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      'A request with this Idempotency-Key is still in flight',
      { key },
    );
  }

  private fresh<T>(claimId: string): IdempotencyOutcome<T> {
    noteIdempotencyClaim(claimId);
    return {
      kind: 'fresh',
      complete: async (result: T) => {
        noteIdempotencyClaim(null);
        // From IN_PROGRESS or from COMMITTED — whichever the transaction left.
        await this.prisma.idempotencyKey.updateMany({
          where: { id: claimId, status: { in: ['IN_PROGRESS', 'COMMITTED'] } },
          data: {
            status: 'COMPLETED',
            responseCode: 200,
            responseBody: result as Prisma.InputJsonValue,
          },
        });
      },
      /**
       * A failed attempt releases the key so the client can correct and retry.
       * Keeping it would make a transient error permanent for that key.
       *
       * Only while nothing committed. A claim the transaction already marked
       * COMMITTED is *kept*: its effects are real, and deleting the row would
       * let a retry apply them again. Whatever failed after the commit — the
       * event publish, the audit row — did not un-happen the fill.
       */
      abandon: async () => {
        noteIdempotencyClaim(null);
        await this.prisma.idempotencyKey
          .deleteMany({ where: { id: claimId, status: 'IN_PROGRESS' } })
          .catch(() => undefined);
      },
    };
  }

  /** Removes expired records. Called by the worker's sweep job. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    if (result.count > 0) this.logger.log(`Swept ${result.count} expired idempotency key(s)`);
    return result.count;
  }
}
