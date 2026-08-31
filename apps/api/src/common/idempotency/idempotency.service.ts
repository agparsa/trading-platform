import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import type { Env } from '../../config/env.schema';
import { requireTenantId } from '@tp/tenancy';

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
      return {
        kind: 'fresh',
        complete: async (result: T) => {
          await this.prisma.idempotencyKey.update({
            where: { id: claimed.id },
            data: {
              status: 'COMPLETED',
              responseCode: 200,
              responseBody: result as Prisma.InputJsonValue,
            },
          });
        },
        // A failed attempt releases the key so the client can correct and retry.
        // Keeping it would make a transient error permanent for that key.
        abandon: async () => {
          await this.prisma.idempotencyKey
            .delete({ where: { id: claimed.id } })
            .catch(() => undefined);
        },
      };
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

    if (existing.status !== 'COMPLETED' || existing.responseBody === null) {
      throw new DomainError(
        TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'A request with this Idempotency-Key is still in flight',
        { key },
      );
    }

    return { kind: 'replayed', result: existing.responseBody as T };
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
