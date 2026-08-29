import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '@tp/shared-types';
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
  readonly data: Record<string, unknown>;
  readonly timestamp: number;
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
  ): Promise<void> {
    const envelope: DomainEventEnvelope = {
      event,
      eventId: randomUUID(),
      origin: INSTANCE_ID,
      accountId,
      data,
      timestamp: Date.now(),
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
