import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Tick } from '@tp/market-core';
import { MarketFeedService } from './market-feed.service';
import { MarketIntegrityService } from './market-integrity.service';
import { QuoteService } from './quote.service';
import { TickBus } from './tick-bus';
import type { LeadershipService } from '../leadership/leadership.service';
import { CandleBus } from './candle-bus';
import { MetricsService } from '../metrics/metrics.service';
import type { SymbolsService } from '../symbols/symbols.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

/**
 * The gate is wired in.
 *
 * `TickGate` is tested in `@tp/market-core` and `MarketIntegrityService` beside
 * it, and both would go on passing if nothing ever called them — which is
 * exactly the state `isBookSane` was in before this milestone: written, tested,
 * and reachable from no code path at all.
 *
 * So this asserts the connection rather than the judgement. A refused tick must
 * reach *nothing*: not the quote, not the tick bus the trigger engine listens
 * on, not the candle aggregator, not Redis. A crossed book that was refused as
 * a quote but still evaluated stops would be the worst of both — the price
 * nobody believes, deciding whether a position closes.
 */

const NOW = 1_756_000_000_000;

const tick = (overrides: Partial<Tick> = {}): Tick => ({
  symbol: 'XAUUSD',
  bid: '4583.58',
  ask: '4583.72',
  timestamp: NOW,
  volume: '1',
  ...overrides,
});

/** An instrument whose session is always open, so the test never depends on the day. */
const ALWAYS_OPEN = {
  spec: { code: 'XAUUSD' },
  session: {
    symbol: 'XAUUSD',
    timezone: 'UTC',
    windows: Array.from({ length: 7 }, (_, day) => ({
      day,
      openMinute: 0,
      closeMinute: 1440,
    })),
  },
};

function build() {
  const published: string[] = [];
  const stored = new Map<string, string>();

  const redis = {
    publisher: {
      publish: async (_channel: string, payload: string) => {
        published.push(payload);
        return 1;
      },
    },
    subscriber: { on: () => undefined, subscribe: async () => 1, unsubscribe: async () => 1 },
    client: {
      set: async (key: string, value: string) => {
        stored.set(key, value);
        return 'OK';
      },
      get: async (key: string) => stored.get(key) ?? null,
    },
  } as unknown as RedisService;

  const config = new ConfigService<Record<string, unknown>, true>({
    QUOTE_MAX_AGE_MS: 5_000,
    MARKET_MAX_SPREAD_RATIO: 0.05,
    MARKET_MAX_JUMP_RATIO: 0.1,
    MARKET_MAX_FUTURE_SKEW_MS: 5_000,
    MARKET_REANCHOR_AFTER: 5,
    CANDLE_RESOLUTIONS: '1',
  } as never);

  const metrics = new MetricsService();
  const quotes = new QuoteService(redis, config as never, metrics);
  const integrity = new MarketIntegrityService(config as never, metrics);
  const ticks = new TickBus();
  const candles = new CandleBus();
  const symbols = { find: () => ALWAYS_OPEN } as unknown as SymbolsService;
  const prisma = { candle: { upsert: vi.fn() } } as unknown as PrismaService;

  const feed = new MarketFeedService(
    config as never,
    symbols,
    quotes,
    integrity,
    prisma,
    redis,
    metrics,
    ticks,
    candles,
    /**
     * This suite drives `ingest` directly to assert what the integrity gate
     * does with a tick. Whether this process is the one allowed to pull ticks
     * from a provider is a different question, answered in `leadership.test.ts`.
     */
    { campaign: () => undefined, isLeading: () => true } as unknown as LeadershipService,
  );

  return { feed, quotes, ticks, published, integrity };
}

describe('MarketFeedService integrity wiring', () => {
  let stack: ReturnType<typeof build>;
  let seen: Tick[];

  beforeEach(() => {
    stack = build();
    seen = [];
    stack.ticks.subscribe((incoming) => {
      seen.push(incoming);
      return Promise.resolve();
    });
  });

  it('passes a sound tick through to the quote, the bus and Redis', async () => {
    await stack.feed.ingest(tick());

    expect((await stack.quotes.latest('XAUUSD'))?.bid).toBe('4583.58');
    expect(seen).toHaveLength(1);
    expect(stack.published).toHaveLength(1);
  });

  it('drops a crossed book before anything sees it', async () => {
    await stack.feed.ingest(tick());
    await stack.feed.ingest(tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + 250 }));

    // The good price still stands.
    expect((await stack.quotes.latest('XAUUSD'))?.bid).toBe('4583.58');
    // And the trigger engine never heard about the bad one.
    expect(seen).toHaveLength(1);
    expect(stack.published).toHaveLength(1);
  });

  it('drops a tick older than the price it already holds', async () => {
    await stack.feed.ingest(tick({ timestamp: NOW }));
    await stack.feed.ingest(tick({ bid: '4000.00', ask: '4000.14', timestamp: NOW - 5_000 }));

    expect((await stack.quotes.latest('XAUUSD'))?.bid).toBe('4583.58');
    expect(seen).toHaveLength(1);
  });

  /**
   * A relayed tick came from another instance over Redis. Re-publishing it
   * would echo between instances forever.
   */
  it('does not re-publish a tick it relayed', async () => {
    await stack.feed.ingest(tick(), { relayed: true });

    expect(seen).toHaveLength(1);
    expect(stack.published).toHaveLength(0);
  });

  it('gates a relayed tick exactly as it gates a local one', async () => {
    await stack.feed.ingest(tick(), { relayed: true });
    await stack.feed.ingest(tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + 250 }), {
      relayed: true,
    });

    expect(seen).toHaveLength(1);
    expect(stack.integrity.summary().rejectedTotal).toBe(1);
  });
});
