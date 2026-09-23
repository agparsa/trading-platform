import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboxEvent } from '@prisma/client';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma.service';
import type { WorkerEnv } from '../env';

export interface OutboxRelaySummary {
  readonly claimed: number;
  readonly relayed: number;
  readonly failed: number;
  readonly abandoned: number;
}

/** What a relay destination does with one event. Phase 12's webhooks are one. */
export interface OutboxDestination {
  readonly name: string;
  deliver(event: OutboxEvent): Promise<void>;
}

/**
 * Relays what the outbox holds, and stops when there is nothing to relay.
 *
 * ## Why a relay at all
 *
 * The row was written inside the transaction that produced the change, so it
 * exists if and only if the change committed. Delivery is the other half:
 * something has to read those rows and hand them on, and it has to be able to
 * crash between reading and delivering without losing or duplicating the
 * event. That is what `status`, `attempts` and `nextAttemptAt` on the row are
 * for — the backoff lives in the database rather than in a queue, so a
 * restart cannot lose it.
 *
 * ## Today it relays to nothing
 *
 * No destination is registered: webhooks are phase 12, and the socket is
 * served directly by `EventsService` for latency. So the relay marks rows
 * RELAYED and the outbox stays a truthful, queryable record of every domain
 * event the platform produced — which is already worth having, and is what
 * "did that event ever go out" is answered from.
 *
 * When a destination is registered, a failure is **kept**: attempts are
 * counted, the next attempt is scheduled with a widening backoff, and after
 * `OUTBOX_MAX_ATTEMPTS` the row is ABANDONED rather than deleted. A financial
 * event that could not be delivered is a thing a person needs to see, not a
 * thing to drop.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly destinations: OutboxDestination[] = [];
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService<WorkerEnv, true>,
  ) {
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true }) ?? 200;
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true }) ?? 10;
  }

  /** Registered at boot. Kept as a list so phase 12 adds one and changes nothing else. */
  register(destination: OutboxDestination): void {
    this.destinations.push(destination);
  }

  async relay(now: Date = new Date()): Promise<OutboxRelaySummary> {
    const due = await withoutTenantScope(
      'the relay carries every firm’s events; each is handled in its own scope',
      () =>
        this.prisma.outboxEvent.findMany({
          where: {
            status: 'PENDING',
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          orderBy: { occurredAt: 'asc' },
          take: this.batchSize,
          include: { tenant: { select: { slug: true, kind: true, status: true } } },
        }),
    );

    const summary = { claimed: due.length, relayed: 0, failed: 0, abandoned: 0 };
    for (const row of due) {
      if (row.tenant.status !== 'ACTIVE') continue;
      const outcome = await withTenant(
        { tenantId: row.tenantId, slug: row.tenant.slug, kind: row.tenant.kind },
        () => this.relayOne(row, now),
      );
      if (outcome === 'RELAYED') summary.relayed += 1;
      else if (outcome === 'ABANDONED') summary.abandoned += 1;
      else summary.failed += 1;
    }
    if (summary.failed > 0 || summary.abandoned > 0) {
      this.logger.warn(summary, 'Outbox relay finished with undelivered events');
    }
    return summary;
  }

  private async relayOne(
    event: OutboxEvent,
    now: Date,
  ): Promise<'RELAYED' | 'FAILED' | 'ABANDONED'> {
    const failures: string[] = [];
    for (const destination of this.destinations) {
      try {
        await destination.deliver(event);
      } catch (error) {
        failures.push(
          `${destination.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failures.length === 0) {
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'RELAYED', relayedAt: now, attempts: { increment: 1 }, lastError: null },
      });
      return 'RELAYED';
    }

    const attempts = event.attempts + 1;
    const abandoned = attempts >= this.maxAttempts;
    await this.prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: abandoned ? 'ABANDONED' : 'PENDING',
        attempts,
        lastError: failures.join('; ').slice(0, 500),
        nextAttemptAt: abandoned ? null : new Date(now.getTime() + backoffMs(attempts)),
      },
    });
    if (abandoned) {
      this.logger.error(
        { eventId: event.eventId, eventType: event.eventType, attempts },
        'An outbox event was abandoned after repeated failures. It is kept, not discarded.',
      );
    }
    return abandoned ? 'ABANDONED' : 'FAILED';
  }
}

/** 1s, 2s, 4s … capped at fifteen minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempts, 20), 15 * 60_000);
}
