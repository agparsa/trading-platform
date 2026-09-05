import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DomainEvent } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { currentRequestScope } from '../common/request-scope';
import { aggregateOf } from '../realtime/events.service';

/**
 * The transactional outbox.
 *
 * A row here is written **in the same transaction as the change it
 * describes**, so a subscriber is told about a fill if and only if the fill
 * committed. The two alternatives both lose: publishing inside the
 * transaction announces a fill a rollback is about to erase, and publishing
 * after it loses the announcement if the process dies in between — which is
 * exactly the window an order fill sits in.
 *
 * ## It does not replace the socket
 *
 * `EventsService` still publishes immediately after the commit, because a
 * trader watching their position should not wait for a relay. The outbox is
 * the *durable* copy: it is what a webhook (phase 12) is delivered from and
 * what answers "did that event ever go out". Both carry the same `eventId`,
 * minted here, so one occurrence has one id however many ways it travels.
 *
 * ## What it is not
 *
 * Not a queue. There is no consumer inside this transaction and no ordering
 * promise beyond `occurredAt`; the relay reads by status. And nothing here
 * decides anything — an outbox row is a record of something that already
 * happened.
 */
@Injectable()
export class OutboxService {
  /**
   * Record an event about to be published. Returns the id it will carry, so
   * the caller can hand the same one to `EventsService.publish` after the
   * commit and a subscriber sees one occurrence, not two.
   */
  record(
    tx: Prisma.TransactionClient,
    event: DomainEvent,
    accountId: string,
    data: Record<string, unknown>,
  ): Promise<{ eventId: string }> {
    const eventId = randomUUID();
    const aggregate = aggregateOf(event, accountId, data);
    const request = currentRequestScope();
    return tx.outboxEvent
      .create({
        data: {
          tenantId: requireTenantId(),
          eventId,
          eventType: event,
          aggregateType: aggregate.type,
          aggregateId: aggregate.id,
          accountId,
          actorId: request?.actorId ?? null,
          correlationId: request?.requestId ?? null,
          causationId: null,
          payload: data as Prisma.InputJsonValue,
        },
        select: { eventId: true },
      })
      .then((row) => ({ eventId: row.eventId }));
  }
}
