import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Tick } from '@tp/market-core';
import { QuoteService } from './quote.service';
import type { RedisService } from '../redis/redis.service';

/**
 * The newest tick wins.
 *
 * Out-of-order delivery is normal on any real transport — a relay hop, a
 * reconnect that replays, two provider connections racing. Before this,
 * `publish` overwrote unconditionally, so a tick that arrived late replaced a
 * newer one, and the *rewound* price then decided whether a stop fired and what
 * every open position was marked at.
 *
 * The rule belongs to the quote rather than to any one caller, which is why it
 * lives here and not only in the integrity gate: `publish` is reachable from
 * the ingest loop, from the relay on a non-ingesting instance, and from tests.
 *
 * Redis is faked rather than run. Nothing under test depends on Redis
 * semantics — it is a string store here — and a unit test that needs a server
 * is a unit test that gets skipped.
 */

/** Just enough of the Redis client for the quote cache. */
function fakeRedis() {
  const store = new Map<string, string>();
  const service = {
    client: {
      set: async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      },
      get: async (key: string) => store.get(key) ?? null,
    },
  } as unknown as RedisService;
  return { service, store };
}

const NOW = 1_756_000_000_000;

const tick = (overrides: Partial<Tick> = {}): Tick => ({
  symbol: 'XAUUSD',
  bid: '4583.58',
  ask: '4583.72',
  timestamp: NOW,
  volume: '1',
  ...overrides,
});

describe('QuoteService ordering', () => {
  let quotes: QuoteService;
  let store: Map<string, string>;

  beforeEach(() => {
    const fake = fakeRedis();
    store = fake.store;
    const config = new ConfigService<Record<string, unknown>, true>({
      QUOTE_MAX_AGE_MS: 5_000,
    } as never);
    quotes = new QuoteService(fake.service, config as never);
  });

  it('accepts a newer tick', async () => {
    expect(await quotes.publish(tick())).toBe(true);
    expect(await quotes.publish(tick({ bid: '4584.00', timestamp: NOW + 500 }))).toBe(true);
    expect((await quotes.latest('XAUUSD'))?.bid).toBe('4584.00');
  });

  it('refuses a tick older than the one it holds, and says so', async () => {
    await quotes.publish(tick());
    const accepted = await quotes.publish(
      tick({ bid: '4000.00', ask: '4000.14', timestamp: NOW - 500 }),
    );

    expect(accepted).toBe(false);
    expect((await quotes.latest('XAUUSD'))?.bid).toBe('4583.58');
  });

  it('does not write a refused tick to the cache either', async () => {
    await quotes.publish(tick());
    await quotes.publish(tick({ bid: '4000.00', ask: '4000.14', timestamp: NOW - 500 }));
    expect(store.get('quote:XAUUSD')).toContain('4583.58');
  });

  it('accepts a tick at the same millisecond, which is normal at any real rate', async () => {
    await quotes.publish(tick());
    expect(await quotes.publish(tick({ bid: '4583.60' }))).toBe(true);
    expect((await quotes.latest('XAUUSD'))?.bid).toBe('4583.60');
  });

  it('does not let one symbol hold another one back', async () => {
    await quotes.publish(tick({ timestamp: NOW }));
    const accepted = await quotes.publish(
      tick({ symbol: 'EURUSD', bid: '1.08750', ask: '1.08755', timestamp: NOW - 60_000 }),
    );
    expect(accepted).toBe(true);
  });

  /**
   * Whatever wrote the Redis copy is another process. A truncated or corrupted
   * value there must not become this process's price with nothing between it
   * and the engine.
   */
  it('refuses a crossed book read back out of Redis', async () => {
    store.set(
      'quote:XAGUSD',
      JSON.stringify({ symbol: 'XAGUSD', bid: '70.0', ask: '69.0', timestamp: NOW, volume: '1' }),
    );
    expect(await quotes.latest('XAGUSD')).toBeNull();
  });

  it('refuses a Redis value that is not JSON', async () => {
    store.set('quote:XAGUSD', 'definitely not json');
    expect(await quotes.latest('XAGUSD')).toBeNull();
  });

  it('adopts a sound Redis value it has never seen locally', async () => {
    store.set('quote:XAGUSD', JSON.stringify(tick({ symbol: 'XAGUSD' })));
    expect((await quotes.latest('XAGUSD'))?.bid).toBe('4583.58');
  });

  it('forgets a symbol on request, and re-reads it from Redis afterwards', async () => {
    await quotes.publish(tick());
    quotes.forget('XAUUSD');
    // Documented behaviour: Redis still holds it, so the next read repopulates.
    expect((await quotes.latest('XAUUSD'))?.bid).toBe('4583.58');

    store.delete('quote:XAUUSD');
    quotes.forget('XAUUSD');
    expect(await quotes.latest('XAUUSD')).toBeNull();
  });

  it('refuses to trade on a price older than the freshness limit', async () => {
    await quotes.publish(tick());
    await expect(quotes.requireFresh('XAUUSD', NOW + 60_000)).rejects.toMatchObject({
      code: 'STALE_QUOTE',
    });
    await expect(quotes.requireFresh('XAUUSD', NOW + 1_000)).resolves.toMatchObject({
      bid: '4583.58',
    });
  });

  it('distinguishes never having had a price from having an old one', async () => {
    await expect(quotes.requireFresh('NOTHING', NOW)).rejects.toMatchObject({
      code: 'NO_QUOTE_AVAILABLE',
    });
  });
});
