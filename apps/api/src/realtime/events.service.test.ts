import { describe, expect, it, vi } from 'vitest';
import { DomainEvent } from '@tp/shared-types';
import {
  EventsService,
  INSTANCE_ID,
  aggregateOf,
  type DomainEventEnvelope,
} from './events.service';
import type { RedisService } from '../redis/redis.service';
import { noteActor, runInRequestScope } from '../common/request-scope';

function serviceWith(published: string[]) {
  const redis = {
    publisher: {
      publish: async (_channel: string, payload: string) => {
        published.push(payload);
        return 1;
      },
    },
  } as unknown as RedisService;
  return new EventsService(redis);
}

/**
 * The double-delivery fix.
 *
 * Redis pub/sub hands a published message to every subscriber — including the
 * connection that published it, because the publisher and subscriber are
 * separate connections and Redis has no way to know they belong to one process.
 * The gateway subscribes to the same channel `EventsService` publishes on, so
 * before this every domain event was handled twice on the instance that raised
 * it. Verified by counting frames on a live socket: one market order produced
 * two `position.created` frames carrying the same position id.
 */
describe('EventsService', () => {
  it('runs local handlers once and publishes once', async () => {
    const published: string[] = [];
    const events = serviceWith(published);
    const handler = vi.fn();
    events.onEvent(handler);

    await events.publish(DomainEvent.POSITION_OPENED, 'account-1', { symbol: 'XAUUSD' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);
  });

  it('stamps every envelope with an occurrence id and this instance', async () => {
    const published: string[] = [];
    const events = serviceWith(published);
    const seen: DomainEventEnvelope[] = [];
    events.onEvent((envelope) => {
      seen.push(envelope);
    });

    await events.publish(DomainEvent.ORDER_FILLED, 'account-1', {});
    await events.publish(DomainEvent.ORDER_FILLED, 'account-1', {});

    expect(seen).toHaveLength(2);
    expect(seen[0]?.origin).toBe(INSTANCE_ID);
    expect(seen[0]?.eventId).not.toBe(seen[1]?.eventId);
    expect(seen[0]?.eventId.length).toBeGreaterThan(0);
  });

  /**
   * Envelope v2: where an event came from, for whoever reads it later.
   *
   * The fields are additive — nothing that read v1 changes — and they are
   * filled from the request scope, so a publisher does not have to know who
   * is asking. Outside a request they are null rather than invented.
   */
  describe('envelope v2', () => {
    it('says what the event is about, from the event name and the id in the data', () => {
      expect(
        aggregateOf(DomainEvent.ORDER_FILLED, 'acc', { orderId: 'o1', positionId: 'p1' }),
      ).toEqual({ type: 'order', id: 'o1' });
      expect(aggregateOf(DomainEvent.POSITION_CLOSED, 'acc', { positionId: 'p1' })).toEqual({
        type: 'position',
        id: 'p1',
      });
      expect(aggregateOf(DomainEvent.BALANCE_CHANGED, 'acc', { positionId: 'p1' })).toEqual({
        type: 'account',
        id: 'acc',
      });
      // A malformed payload falls back to the account rather than to "undefined".
      expect(aggregateOf(DomainEvent.ORDER_CREATED, 'acc', {})).toEqual({
        type: 'account',
        id: 'acc',
      });
    });

    it('carries the request and the actor when published from one, and nulls when not', async () => {
      const published: string[] = [];
      const events = serviceWith(published);
      const seen: DomainEventEnvelope[] = [];
      events.onEvent((envelope) => {
        seen.push(envelope);
      });

      await runInRequestScope({ requestId: 'req-42', actorId: null }, async () => {
        noteActor('user-7');
        await events.publish(
          DomainEvent.ORDER_FILLED,
          'account-1',
          { orderId: 'o1' },
          {
            causationId: 'evt-0',
          },
        );
      });
      await events.publish(DomainEvent.BALANCE_CHANGED, 'account-1', {});

      expect(seen[0]).toMatchObject({
        version: 2,
        aggregateType: 'order',
        aggregateId: 'o1',
        actorId: 'user-7',
        correlationId: 'req-42',
        causationId: 'evt-0',
      });
      expect(seen[1]).toMatchObject({
        version: 2,
        aggregateType: 'account',
        aggregateId: 'account-1',
        actorId: null,
        correlationId: null,
        causationId: null,
      });
      // The Redis hop carries the same fields.
      expect(JSON.parse(published[0] as string)).toMatchObject({ correlationId: 'req-42' });
    });
  });

  /**
   * The frame the gateway receives back from Redis after publishing it. Handling
   * it would deliver the event to every local socket a second time.
   */
  it('refuses its own echo off Redis', async () => {
    const published: string[] = [];
    const events = serviceWith(published);
    const handler = vi.fn();
    events.onEvent(handler);

    await events.publish(DomainEvent.POSITION_OPENED, 'account-1', {});
    expect(handler).toHaveBeenCalledTimes(1);

    // Exactly what Redis sends back: the envelope this instance just published.
    const echo = JSON.parse(published[0] ?? '{}') as DomainEventEnvelope;
    const delivered = await events.deliverRemote(echo);

    expect(delivered).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half. Refusing the echo must not refuse a *genuine* remote event,
   * or a second API instance would stop seeing the first one's fills — which is
   * the whole reason the Redis hop exists.
   */
  it('delivers an event from another instance', async () => {
    const events = serviceWith([]);
    const handler = vi.fn();
    events.onEvent(handler);

    const fromElsewhere: DomainEventEnvelope = {
      event: DomainEvent.POSITION_OPENED,
      eventId: 'evt-1',
      origin: 'a-different-process',
      accountId: 'account-1',
      tenantId: '00000000-0000-4000-8000-0000000000ff',
      data: {},
      timestamp: Date.now(),
      version: 2,
      aggregateType: 'account',
      aggregateId: 'account-1',
      actorId: null,
      correlationId: null,
      causationId: null,
    };
    const delivered = await events.deliverRemote(fromElsewhere);

    expect(delivered).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(fromElsewhere);
  });

  it('keeps the occurrence id across the Redis hop, so a duplicate is recognisable', async () => {
    const published: string[] = [];
    const events = serviceWith(published);
    const seen: DomainEventEnvelope[] = [];
    events.onEvent((envelope) => {
      seen.push(envelope);
    });

    await events.publish(DomainEvent.ORDER_FILLED, 'account-1', {});
    const overTheWire = JSON.parse(published[0] ?? '{}') as DomainEventEnvelope;

    expect(overTheWire.eventId).toBe(seen[0]?.eventId);
  });

  /**
   * A committed fill must not be undone because a notification could not be
   * sent. Redis is a transport here and carries no financial truth.
   */
  it('does not let a Redis failure escape into the trade that produced it', async () => {
    const redis = {
      publisher: {
        publish: async () => {
          throw new Error('redis is down');
        },
      },
    } as unknown as RedisService;
    const events = new EventsService(redis);
    const handler = vi.fn();
    events.onEvent(handler);

    await expect(
      events.publish(DomainEvent.POSITION_OPENED, 'account-1', {}),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
