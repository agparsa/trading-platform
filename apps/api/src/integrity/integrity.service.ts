import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { detectAll, type ActivityWindow, type Signal } from '@tp/integrity-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { requireTenantId } from '@tp/tenancy';

export interface SignalSummary {
  id: string;
  accountId: string;
  code: string;
  severity: string;
  status: string;
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** How far back an observation window looks. Wide enough to see a pattern. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Raises and reviews integrity signals.
 *
 * Two things this service is careful never to be.
 *
 * **It is not in the execution path.** Nothing here is called while an order is
 * being placed, filled or closed. It reads records after the fact, on its own
 * schedule or on demand, and a failure in it can delay a review — never a trade.
 * An anti-fraud engine that can stop a fill is an anti-fraud engine that will
 * one day stop a legitimate one.
 *
 * **It does not accuse anybody.** A signal is an observation with its evidence
 * attached, raised for a person to look at. The status vocabulary includes
 * `FALSE_POSITIVE` as a first-class outcome precisely because the engine is
 * expected to be wrong sometimes, and an operator needs a way to say so that is
 * not "resolved".
 *
 * What it may see is narrow by construction: orders, positions and exposure —
 * records trading already produced. It reads nothing about a person that
 * trading did not already require. See `docs/anti-fraud.md`.
 */
@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Observes one account and records whatever the detectors noticed. */
  async scanAccount(accountId: string, nowMs = Date.now()): Promise<Signal[]> {
    const window = await this.observe(accountId, nowMs);
    const signals = detectAll(window);
    for (const signal of signals) await this.raise(accountId, signal);
    return signals;
  }

  /**
   * Observes every account that has traded inside the window.
   *
   * Scoped to recent activity rather than every account that exists: a dormant
   * account cannot have produced a pattern, and scanning it is work whose answer
   * is known in advance.
   */
  async scanAll(nowMs = Date.now()): Promise<{ scanned: number; raised: number }> {
    const since = new Date(nowMs - WINDOW_MS);
    const active = await this.prisma.order.findMany({
      where: { createdAt: { gte: since } },
      select: { accountId: true },
      distinct: ['accountId'],
    });

    let raised = 0;
    for (const { accountId } of active) {
      try {
        raised += (await this.scanAccount(accountId, nowMs)).length;
      } catch (error) {
        // One account that cannot be observed must not cost every other account
        // its scan.
        this.logger.error({ err: error, accountId }, 'Integrity scan failed for an account');
      }
    }
    return { scanned: active.length, raised };
  }

  /**
   * Records an observation.
   *
   * A pattern that keeps recurring is the *same* signal seen again, not a queue
   * of identical ones — so the row is upserted and its occurrence count grows,
   * while every individual sighting is appended to the event log. A thousand
   * duplicate rows would hide the one fact a reviewer needs, which is how
   * persistent this is.
   *
   * A recurrence deliberately does **not** reopen a signal an operator has
   * already dismissed. Re-raising something marked `FALSE_POSITIVE` every time
   * the pattern repeats is how a review queue becomes unusable, and how the
   * operator's judgement gets silently overruled by a threshold.
   */
  private async raise(accountId: string, signal: Signal): Promise<void> {
    const existing = await this.prisma.integritySignal.findUnique({
      where: { accountId_code: { accountId, code: signal.code } },
      select: { id: true, status: true, occurrences: true },
    });

    const evidence = signal.evidence as Prisma.InputJsonValue;

    if (existing === null) {
      const created = await this.prisma.integritySignal.create({
        data: {
          tenantId: requireTenantId(),
          accountId,
          code: signal.code,
          severity: signal.severity,
          message: signal.message,
          events: {
            create: {
              tenantId: requireTenantId(),
              type: 'RAISED',
              toStatus: 'OPEN',
              severity: signal.severity,
              message: signal.message,
              evidence,
            },
          },
        },
      });
      this.logger.warn(
        { accountId, code: signal.code, severity: signal.severity },
        `INTEGRITY SIGNAL ${signal.code}: ${signal.message}`,
      );
      await this.audit.record({
        actorType: 'SYSTEM',
        action: 'integrity.signal_raised',
        resourceType: 'IntegritySignal',
        resourceId: created.id,
        after: { code: signal.code, severity: signal.severity, message: signal.message },
      });
      return;
    }

    await this.prisma.integritySignal.update({
      where: { id: existing.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        severity: signal.severity,
        message: signal.message,
        events: {
          create: {
            tenantId: requireTenantId(),
            type: 'RECURRED',
            severity: signal.severity,
            message: signal.message,
            evidence,
          },
        },
      },
    });
  }

  async list(filter: { status?: string; accountId?: string; limit: number }) {
    const signals = await this.prisma.integritySignal.findMany({
      where: {
        ...(filter.status === undefined ? {} : { status: filter.status as never }),
        ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
      },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: filter.limit,
    });
    return signals.map((signal) => this.toSummary(signal));
  }

  /** One signal with its whole history, which is the point of keeping one. */
  async detail(signalId: string) {
    const signal = await this.prisma.integritySignal.findUnique({
      where: { id: signalId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (signal === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Signal not found', { signalId });
    }
    return {
      ...this.toSummary(signal),
      events: signal.events.map((event) => ({
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        severity: event.severity,
        message: event.message,
        evidence: event.evidence,
        actorId: event.actorId,
        at: event.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Moves a signal through review.
   *
   * The status field changes; nothing else does. The previous state is appended
   * to the event log rather than replaced, so "what did this look like when it
   * was raised" stays answerable after somebody has closed it — which is the
   * whole reason the log exists.
   */
  async setStatus(
    actorId: string,
    signalId: string,
    status: string,
    note?: string,
  ): Promise<SignalSummary> {
    const existing = await this.prisma.integritySignal.findUnique({ where: { id: signalId } });
    if (existing === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Signal not found', { signalId });
    }

    const updated = await this.prisma.integritySignal.update({
      where: { id: signalId },
      data: {
        status: status as never,
        reviewedByUserId: actorId,
        reviewedAt: new Date(),
        events: {
          create: {
            tenantId: requireTenantId(),
            type: 'STATUS_CHANGED',
            fromStatus: existing.status,
            toStatus: status as never,
            ...(note === undefined || note.trim() === '' ? {} : { message: note.trim() }),
            actorId,
          },
        },
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'integrity.signal_reviewed',
      resourceType: 'IntegritySignal',
      resourceId: signalId,
      before: { status: existing.status },
      after: { status, ...(note === undefined ? {} : { note }) },
    });

    return this.toSummary(updated);
  }

  /**
   * The account's recent activity, as the engine is allowed to see it.
   *
   * Every field here exists because trading produced it. Nothing is collected
   * about a person that placing an order did not already require — no device
   * fingerprint, no browsing history, no keystroke timing. The engine's
   * usefulness is not worth becoming surveillance for.
   */
  private async observe(accountId: string, nowMs: number): Promise<ActivityWindow> {
    const since = new Date(nowMs - WINDOW_MS);
    const [orders, closed, open, churn] = await Promise.all([
      this.prisma.order.findMany({
        where: { accountId, createdAt: { gte: since } },
        select: {
          id: true,
          createdAt: true,
          status: true,
          side: true,
          volume: true,
          price: true,
          symbol: { select: { code: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.position.findMany({
        where: { accountId, status: 'CLOSED', closedAt: { gte: since } },
        select: {
          id: true,
          openedAt: true,
          closedAt: true,
          symbol: { select: { code: true } },
        },
      }),
      this.prisma.position.findMany({
        where: { accountId, status: { in: ['OPEN', 'CLOSING'] } },
        select: {
          volume: true,
          entryPrice: true,
          symbol: { select: { code: true, spec: { select: { contractSize: true } } } },
        },
      }),
      /**
       * Amendments and cancellations on resting orders (§46).
       *
       * Read from `OrderEvent`, which the platform already writes because the
       * audit trail must show the same shape for every order. Nothing new is
       * collected to make this detector possible — which is the rule this whole
       * method is written to.
       *
       * `MODIFIED` and `CANCELLED`, not the `*_REQUESTED` pair: a request that
       * was refused is not churn on the book, and counting it would report a
       * trader whose amendments keep bouncing off a validation rule as though
       * they were working the order.
       */
      this.prisma.orderEvent.findMany({
        where: {
          order: { accountId },
          type: { in: ['MODIFIED', 'CANCELLED'] },
          createdAt: { gte: since },
        },
        select: { orderId: true, type: true, createdAt: true },
        take: 5_000,
      }),
    ]);

    /**
     * Exposure at entry price rather than at the mark.
     *
     * A concentration observation must not change because a quote moved: a
     * signal that appears and disappears with the market is noise, and the
     * question being asked — "is most of this book in one instrument" — is about
     * what was taken on, not what it is worth this second.
     */
    const bySymbol = new Map<string, { symbol: string; grossNotional: string }>();
    for (const position of open) {
      const contractSize = position.symbol.spec?.contractSize.toString() ?? '1';
      const notional =
        Number(position.volume.toString()) *
        Number(contractSize) *
        Number(position.entryPrice.toString());
      const code = position.symbol.code;
      const running = Number(bySymbol.get(code)?.grossNotional ?? '0') + notional;
      bySymbol.set(code, { symbol: code, grossNotional: running.toFixed(2) });
    }

    return {
      accountId,
      nowMs,
      orders: orders.map((order) => ({
        id: order.id,
        createdAtMs: order.createdAt.getTime(),
        status: order.status,
        symbol: order.symbol.code,
        side: order.side,
        volume: order.volume.toString(),
        price: order.price?.toString() ?? null,
      })),
      closedPositions: closed
        .filter(
          (position): position is typeof position & { closedAt: Date } =>
            position.closedAt !== null,
        )
        .map((position) => ({
          id: position.id,
          symbol: position.symbol.code,
          openedAtMs: position.openedAt.getTime(),
          closedAtMs: position.closedAt.getTime(),
        })),
      exposure: [...bySymbol.values()],
      orderChurn: churn.map((event) => ({
        orderId: event.orderId,
        kind: event.type === 'MODIFIED' ? ('MODIFIED' as const) : ('CANCELLED' as const),
        atMs: event.createdAt.getTime(),
      })),
    };
  }

  private toSummary(signal: {
    id: string;
    accountId: string;
    code: string;
    severity: string;
    status: string;
    message: string;
    occurrences: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }): SignalSummary {
    return {
      id: signal.id,
      accountId: signal.accountId,
      code: signal.code,
      severity: signal.severity,
      status: signal.status,
      message: signal.message,
      occurrences: signal.occurrences,
      firstSeenAt: signal.firstSeenAt.toISOString(),
      lastSeenAt: signal.lastSeenAt.toISOString(),
    };
  }
}
