import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '@tp/shared-types';
import { RedisService } from '../redis/redis.service';

/** Redis channel every API instance relays to its own connected sockets. */
export const DOMAIN_EVENT_CHANNEL = 'domain:events';

export interface DomainEventEnvelope {
  readonly event: DomainEvent;
  /** Owning account, so an instance can route the frame to the right sockets. */
  readonly accountId: string;
  readonly data: Record<string, unknown>;
  readonly timestamp: number;
}

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
    const envelope: DomainEventEnvelope = { event, accountId, data, timestamp: Date.now() };

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

  /** Delivers an envelope that arrived from another instance. */
  async deliverRemote(envelope: DomainEventEnvelope): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(envelope);
      } catch (error) {
        this.logger.error({ err: error }, 'Remote domain event handler failed');
      }
    }
  }
}
