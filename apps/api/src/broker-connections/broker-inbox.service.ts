import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { BrokerEvent } from '@tp/broker-sdk';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordedInbound {
  readonly id: string;
  /** False when this connection had already recorded that external id. */
  readonly fresh: boolean;
}

export interface InboxPage {
  readonly events: readonly {
    readonly id: string;
    readonly externalEventId: string;
    readonly sequence: string | null;
    readonly kind: string;
    readonly externalAccountId: string | null;
    readonly status: string;
    readonly attempts: number;
    readonly lastError: string | null;
    readonly skipReason: string | null;
    readonly occurredAt: Date;
    readonly receivedAt: Date;
    readonly appliedAt: Date | null;
  }[];
}

/**
 * What a venue told us, recorded before it is acted on.
 *
 * ## The three things a venue does that are not errors
 *
 * **It redelivers.** The same event arrives twice because its acknowledgement
 * was lost. `(connectionId, externalEventId)` is unique, so the second
 * insert loses the race and is reported as a duplicate — not a failure, and
 * not a second fill.
 *
 * **It delivers late.** An event about a fill from four minutes ago arrives
 * after one from four seconds ago. `sequence` is kept as the venue gave it,
 * so a reader can order by the venue's clock rather than ours.
 *
 * **It delivers out of order.** Handled the same way: the platform records
 * first and reasons afterwards, in sequence order, rather than acting on
 * whatever arrived most recently.
 *
 * ## Recording is separate from applying
 *
 * An event the platform cannot yet make sense of — an account it does not
 * map, a kind this build does not handle — is still evidence, and a
 * discrepancy investigated a week later needs what the venue actually said.
 * So the row is written whatever happens next, the payload is fixed by a
 * database trigger, and only the handling status moves.
 *
 * Applying an event to the trading rows is the external execution path's
 * job, not this service's. This one is the ledger of what arrived.
 */
@Injectable()
export class BrokerInboxService {
  private readonly logger = new Logger(BrokerInboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one event. Idempotent on `(connection, externalEventId)`: a
   * redelivery returns the row that is already there, with `fresh: false`.
   */
  async record(connectionId: string, event: BrokerEvent): Promise<RecordedInbound> {
    const tenantId = requireTenantId();
    try {
      const created = await this.prismaCreate(tenantId, connectionId, event);
      return { id: created.id, fresh: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      /**
       * The other side of the race, or a genuine redelivery. Both mean the
       * same thing — this occurrence is already on record — and the platform
       * treats them identically rather than trying to tell them apart.
       */
      const existing = await this.prisma.brokerInboundEvent.findFirst({
        where: { connectionId, externalEventId: event.externalEventId },
        select: { id: true },
      });
      if (existing === null) throw error;
      return { id: existing.id, fresh: false };
    }
  }

  /** Record a batch, in the order the venue's sequence puts them. */
  async recordAll(
    connectionId: string,
    events: readonly BrokerEvent[],
  ): Promise<{ recorded: number; duplicates: number }> {
    const ordered = [...events].sort(bySequenceThenTime);
    let recorded = 0;
    let duplicates = 0;
    for (const event of ordered) {
      const result = await this.record(connectionId, event);
      if (result.fresh) recorded += 1;
      else duplicates += 1;
    }
    if (duplicates > 0) {
      this.logger.log(
        { connectionId, recorded, duplicates },
        'The venue redelivered events it had already sent',
      );
    }
    return { recorded, duplicates };
  }

  /** What has not been applied yet, oldest by the venue's own ordering. */
  async pending(connectionId: string, limit = 200): Promise<InboxPage> {
    const rows = await this.prisma.brokerInboundEvent.findMany({
      where: { connectionId, status: 'PENDING' },
      orderBy: [{ sequence: 'asc' }, { occurredAt: 'asc' }],
      take: Math.min(Math.max(limit, 1), 1_000),
    });
    return { events: rows.map(toView) };
  }

  async list(connectionId: string, limit = 100): Promise<InboxPage> {
    const rows = await this.prisma.brokerInboundEvent.findMany({
      where: { connectionId },
      orderBy: { receivedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return { events: rows.map(toView) };
  }

  async markApplied(id: string): Promise<void> {
    await this.prisma.brokerInboundEvent.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPLIED', appliedAt: new Date(), attempts: { increment: 1 } },
    });
  }

  /** Nothing to do with it, and that is a decision worth recording. */
  async markSkipped(id: string, reason: string): Promise<void> {
    await this.prisma.brokerInboundEvent.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'SKIPPED', skipReason: reason.slice(0, 500), attempts: { increment: 1 } },
    });
  }

  /**
   * Could not be applied. Stays FAILED and stays readable: an event the
   * platform choked on is the first thing an investigation wants, and
   * deleting it would leave a fill nobody can explain.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.brokerInboundEvent.updateMany({
      where: { id },
      data: { status: 'FAILED', lastError: error.slice(0, 500), attempts: { increment: 1 } },
    });
  }

  /** Put a failed event back in the queue, to be applied by corrected code. */
  async replay(id: string): Promise<void> {
    await this.prisma.brokerInboundEvent.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', lastError: null },
    });
  }

  private prismaCreate(tenantId: string, connectionId: string, event: BrokerEvent) {
    return this.prisma.brokerInboundEvent.create({
      data: {
        tenantId,
        connectionId,
        externalEventId: event.externalEventId,
        sequence: event.sequence === null ? null : BigInt(event.sequence),
        kind: event.kind,
        externalAccountId: event.externalAccountId,
        payload: event.payload as Prisma.InputJsonValue,
        occurredAt: event.at,
      },
      select: { id: true },
    });
  }
}

interface InboundRow {
  id: string;
  externalEventId: string;
  sequence: bigint | null;
  kind: string;
  externalAccountId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  occurredAt: Date;
  receivedAt: Date;
  appliedAt: Date | null;
}

function toView(row: InboundRow) {
  return {
    id: row.id,
    externalEventId: row.externalEventId,
    // A bigint does not survive JSON. The venue's ordering is a label here,
    // not arithmetic, so it travels as the string it came from.
    sequence: row.sequence === null ? null : row.sequence.toString(),
    kind: row.kind,
    externalAccountId: row.externalAccountId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    skipReason: row.skipReason,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    appliedAt: row.appliedAt,
  };
}

/** The venue's sequence when it gave one, its clock when it did not. */
function bySequenceThenTime(a: BrokerEvent, b: BrokerEvent): number {
  if (a.sequence !== null && b.sequence !== null) return a.sequence - b.sequence;
  return a.at.getTime() - b.at.getTime();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
