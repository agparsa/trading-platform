import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '@tp/shared-types';
import { currentTenant } from '@tp/tenancy';
import { currentRequestScope } from '../common/request-scope';
import { RedisService } from '../redis/redis.service';

/** Redis channel every API instance relays to its own connected sockets. */
export const DOMAIN_EVENT_CHANNEL = 'domain:events';

export interface DomainEventEnvelope {
  readonly event: DomainEvent;
  /**
   * Identifies the occurrence. Travels to the WebSocket frame so a client can
   * discard a duplicate, and lets an instance recognise its own echo.
   */
  readonly eventId: string;
  /**
   * Which API process published this.
   *
   * Redis pub/sub delivers a message to every subscriber including the one that
   * published it — the publisher and subscriber are separate connections, so
   * Redis has no way to know they are the same process. Without this field the
   * gateway handled every event twice: once from the local handler, once from
   * its own echo off Redis. Verified by counting frames: one market order
   * produced two `position.created` frames carrying the same position id.
   */
  readonly origin: string;
  /** Owning account, so an instance can route the frame to the right sockets. */
  readonly accountId: string;
  /**
   * The tenant this happened in.
   *
   * Carried on the envelope rather than looked up, because a handler on
   * *another* instance receives this over Redis with no request and therefore
   * no tenant scope at all — `requireTenantId()` there throws, and a handler
   * that needs to touch the database has nothing to go on. Null only for an
   * envelope published outside any scope, which should not happen and is
   * treated as "cannot be handled" rather than "belongs to the default tenant".
   */
  readonly tenantId: string | null;
  readonly data: Record<string, unknown>;
  readonly timestamp: number;

  // ---- Envelope v2 -------------------------------------------------------
  // Additive: every consumer of v1 reads the fields above and ignores these.
  // They exist so an event can be traced back to what caused it — by a
  // webhook subscriber, an outbox reader, or somebody with a log file — and
  // so the same envelope can be the body of a webhook without reshaping.

  /** 2. A consumer that finds it missing is reading a v1 envelope. */
  readonly version: 2;
  /** What the event is about: `order`, `position`, `account`. */
  readonly aggregateType: AggregateType;
  /** That thing's id. The account's when the event is about the account. */
  readonly aggregateId: string;
  /** The person (or credential) whose request caused this. Null for the engine's own work. */
  readonly actorId: string | null;
  /** The request id, so a client's trace and this event share a key. Null outside a request. */
  readonly correlationId: string | null;
  /** The event this one followed from, when the publisher knows. */
  readonly causationId: string | null;
}

export type AggregateType = 'order' | 'position' | 'account';

/**
 * What an event is about, from its name. Every event in the catalogue is
 * named `<aggregate>.<what happened>`, except the two account-level ones that
 * predate the convention; the table keeps those honest.
 */
export function aggregateOf(
  event: DomainEvent,
  accountId: string,
  data: Record<string, unknown>,
): { type: AggregateType; id: string } {
  const prefix = event.split('.')[0];
  if (prefix === 'order' && typeof data['orderId'] === 'string') {
    return { type: 'order', id: data['orderId'] };
  }
  if (prefix === 'position' && typeof data['positionId'] === 'string') {
    return { type: 'position', id: data['positionId'] };
  }
  return { type: 'account', id: accountId };
}

/** What a publisher may add to the envelope beyond the event itself. */
export interface PublishOptions {
  /** The event this one followed from. */
  readonly causationId?: string | null;
  /**
   * The occurrence's id, when it has already been minted — by the outbox,
   * inside the transaction that produced the change. One occurrence then has
   * one id however many ways it travels, and a subscriber reading both the
   * socket and a webhook can tell they are the same thing.
   */
  readonly eventId?: string;
}

/**
 * This process, for the life of the process.
 *
 * Deliberately not a configured instance name: two processes must differ, and
 * nothing else about this value matters. A restart producing a new id is correct
 * — the old process is not listening any more.
 */
export const INSTANCE_ID = randomUUID();

export type DomainEventHandler = (envelope: DomainEventEnvelope) => void | Promise<void>;

/**
 * Publishes domain events.
 *
 * Two hops, deliberately. Local handlers run immediately, so a socket connected
 * to this instance sees a fill without a Redis round trip. The same envelope is
 * also published to Redis, so sockets on *other* instances see it too.
 *
 * Redis carries no financial truth here — it is a transport. A Redis outage
 * costs remote clients a re-snapshot, never a wrong balance, which is why
 * publishing failures are logged and swallowed rather than propagated into the
 * trade that produced them. A committed fill must not be undone because a
 * notification could not be sent.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly handlers = new Set<DomainEventHandler>();

  constructor(private readonly redis: RedisService) {}

  onEvent(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(
    event: DomainEvent,
    accountId: string,
    data: Record<string, unknown>,
    options: PublishOptions = {},
  ): Promise<void> {
    const aggregate = aggregateOf(event, accountId, data);
    const request = currentRequestScope();
    const envelope: DomainEventEnvelope = {
      event,
      eventId: options.eventId ?? randomUUID(),
      origin: INSTANCE_ID,
      accountId,
      // Captured here, where a request scope still exists. By the time a
      // handler on another instance sees this, there is none.
      tenantId: currentTenant()?.tenantId ?? null,
      data,
      timestamp: Date.now(),
      version: 2,
      aggregateType: aggregate.type,
      aggregateId: aggregate.id,
      actorId: request?.actorId ?? null,
      correlationId: request?.requestId ?? null,
      causationId: options.causationId ?? null,
    };

    for (const handler of this.handlers) {
      try {
        await handler(envelope);
      } catch (error) {
        this.logger.error({ err: error, event }, 'Local domain event handler failed');
      }
    }

    try {
      await this.redis.publisher.publish(DOMAIN_EVENT_CHANNEL, JSON.stringify(envelope));
    } catch (error) {
      this.logger.error({ err: error, event }, 'Failed to publish a domain event to Redis');
    }
  }

  /**
   * Delivers an envelope that arrived from another instance.
   *
   * Refuses this instance's own echo. Redis has no idea that the publisher and
   * subscriber connections belong to the same process, so it hands the message
   * straight back; without this check the local handlers would run a second
   * time and every socket on this instance would see the event twice.
   *
   * Returns whether it delivered, so the caller can count what it dropped.
   */
  async deliverRemote(envelope: DomainEventEnvelope): Promise<boolean> {
    if (envelope.origin === INSTANCE_ID) return false;

    for (const handler of this.handlers) {
      try {
        await handler(envelope);
      } catch (error) {
        this.logger.error({ err: error }, 'Remote domain event handler failed');
      }
    }
    return true;
  }
}
