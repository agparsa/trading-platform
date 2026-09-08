import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import type { Tick } from '@tp/market-core';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { ExposureIndex } from '../../src/realtime/exposure-index';
import { EventsService } from '../../src/realtime/events.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import { TickBus } from '../../src/market/tick-bus';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The latency numbers §34 asks for, measured where a decision is actually made.
 *
 * Every one of these is measured from the *tick's own timestamp* rather than
 * from the start of the stage that reports it. Per-hop timings can all look
 * healthy while the trader's screen is four seconds behind, because what makes
 * it four seconds behind is the queueing between the hops.
 *
 * The assertions are about what was observed and what it was measured against,
 * not about how fast this machine is. A test that asserts a latency is under
 * 50ms is a test that fails on a busy CI box and teaches nobody anything.
 */
suite('latency metrics', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let metrics: MetricsService;
  let realtime: RealtimeService;
  let listening: Set<string>;

  const sample = async (name: string): Promise<{ count: number; sum: number }> => {
    const all = await metrics.registry.getMetricsAsJSON();
    const metric = all.find((entry) => entry.name === name);
    const values = (metric?.values ?? []) as Array<{
      metricName?: string;
      value: number;
    }>;
    const count = values.find((value) => value.metricName === `${name}_count`)?.value ?? 0;
    const sum = values.find((value) => value.metricName === `${name}_sum`)?.value ?? 0;
    return { count, sum };
  };

  /** `tp_order_stage_seconds_count` per stage. */
  const stageCounts = async (): Promise<Record<string, number>> => {
    const all = await metrics.registry.getMetricsAsJSON();
    const metric = all.find((entry) => entry.name === 'tp_order_stage_seconds');
    const values = (metric?.values ?? []) as Array<{
      metricName?: string;
      labels: { stage?: string };
      value: number;
    }>;
    const counts: Record<string, number> = {};
    for (const value of values) {
      if (value.metricName !== 'tp_order_stage_seconds_count') continue;
      const stage = value.labels.stage;
      if (stage !== undefined) counts[stage] = value.value;
    }
    return counts;
  };

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    /**
     * The stack's own registry, not a fresh one. The quote age is recorded by
     * `QuoteService` deep inside the order path; a test holding a different
     * registry would assert against a counter nothing writes to and pass for
     * the wrong reason.
     */
    metrics = stack.metrics;
    listening = new Set<string>();

    const gateway = {
      tenantsOfListeners: () => [
        {
          tenant: { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG },
          accounts: listening,
        },
      ],
      sendToAccount: () => 1,
      onAccountAbandoned: () => () => undefined,
    } as unknown as RealtimeGateway;

    const prismaService = prisma as unknown as PrismaService;
    const fakeRedis = {
      publisher: { publish: async () => 1 },
      subscriber: { subscribe: async () => 1, on: () => undefined, unsubscribe: async () => 1 },
    } as unknown as RedisService;

    realtime = new RealtimeService(
      new ConfigService({ REALTIME_VALUATION_INTERVAL_MS: 0 } as never) as never,
      prismaService,
      stack.accountState,
      gateway,
      new TickBus(),
      new ExposureIndex(prismaService, new EventsService(fakeRedis), 30_000),
      { raise: async () => undefined } as unknown as NotificationsService,
      metrics,
    );
  });

  const tickAt = (timestamp: number): Tick => ({
    symbol: 'XAUUSD',
    bid: '4583.58',
    ask: '4583.72',
    timestamp,
    volume: '1',
  });

  const exposedTrader = async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    listening.add(accountId);
    return accountId;
  };

  it('measures the P&L a tick produced against that tick, not against the pass', async () => {
    await exposedTrader();

    // A tick that arrived a second ago and has not reached anybody yet.
    const arrivedAt = Date.now() - 1_000;
    realtime.onTick(tickAt(arrivedAt));
    await realtime.drain();

    const pnl = await sample('tp_tick_to_pnl_seconds');
    expect(pnl.count).toBe(1);
    expect(pnl.sum).toBeGreaterThanOrEqual(1);
  });

  /**
   * The clock starts at the first move nobody has been told about. Measuring
   * against the newest tick would report a healthy platform precisely when it
   * is furthest behind — a backlog makes the newest tick *younger*, not older.
   */
  it('measures from the oldest tick in the pass, not the newest', async () => {
    await exposedTrader();

    realtime.onTick(tickAt(Date.now() - 3_000));
    realtime.onTick(tickAt(Date.now() - 10));
    await realtime.drain();

    const pnl = await sample('tp_tick_to_pnl_seconds');
    expect(pnl.count).toBe(1);
    expect(pnl.sum).toBeGreaterThanOrEqual(3);
  });

  it('measures the socket hand-off as well, never earlier than the valuation', async () => {
    await exposedTrader();

    realtime.onTick(tickAt(Date.now() - 500));
    await realtime.drain();

    const pnl = await sample('tp_tick_to_pnl_seconds');
    const socket = await sample('tp_tick_to_socket_seconds');
    expect(socket.count).toBe(1);
    expect(socket.sum).toBeGreaterThanOrEqual(pnl.sum);
  });

  it('records nothing when no instrument moved', async () => {
    await exposedTrader();
    await realtime.drain();

    expect((await sample('tp_tick_to_pnl_seconds')).count).toBe(0);
    expect((await sample('tp_tick_to_socket_seconds')).count).toBe(0);
  });

  /**
   * The age of the price something was *decided on*, which is not the same
   * question as whether the feed is alive. A feed that is healthy overall while
   * one instrument has not printed for a minute reads as fine on the feed gauge
   * and badly here — and here is the one that matters to the fill.
   */
  /**
   * §50: where an order spent its time. `tp_order_ack_seconds` says a
   * submission took 300ms; only this says whether that was the risk valuation,
   * the venue or a row lock.
   */
  it('records where an accepted order spent its time', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');

    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    const stages = await stageCounts();
    expect(stages['received']).toBe(1);
    expect(stages['validated']).toBe(1);
    expect(stages['priced']).toBe(1);
    expect(stages['executed']).toBe(1);
  });

  /**
   * A refusal usually happens *after* the risk checks rather than before them,
   * so the path that ends in "no" is often the slower of the two. Recording
   * only successes would leave the expensive half of the traffic unmeasured.
   */
  it('records a refused order too, and only the stages it reached', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');

    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        // Below the minimum lot: refused at validation, before anything is priced.
        volume: '0.0001',
      }),
    ).rejects.toThrow();

    const stages = await stageCounts();
    expect(stages['received']).toBe(1);
    // Never priced, never executed — and absent rather than recorded as zero,
    // which would put a spike of zeros into those percentiles.
    expect(stages['priced'] ?? 0).toBe(0);
    expect(stages['executed'] ?? 0).toBe(0);
  });

  it('records how old the price was when an order used it', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');

    const before = await sample('tp_quote_age_seconds');
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    const after = await sample('tp_quote_age_seconds');
    expect(after.count).toBeGreaterThan(before.count);
  });
});
