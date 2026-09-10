import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import type { Tick } from '@tp/market-core';
import { RiskState, WsChannel } from '@tp/shared-types';
import { MetricsService } from '../../src/metrics/metrics.service';
import { EventsService } from '../../src/realtime/events.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { ExposureIndex } from '../../src/realtime/exposure-index';
import { RealtimeService } from '../../src/realtime/realtime.service';
import type { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { TickBus } from '../../src/market/tick-bus';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

const BID = '4583.58';
const ASK = '4583.72';

const fakeRedis = {
  publisher: { publish: async () => 1 },
  subscriber: { subscribe: async () => 1, on: () => undefined, unsubscribe: async () => 1 },
} as unknown as RedisService;

interface SentFrame {
  accountId: string;
  channel: WsChannel;
  event: string;
  data: Record<string, unknown>;
}

/**
 * Risk-state frames.
 *
 * The rule that matters is **transition only**. An account whose margin level
 * sits at 94% for an hour must produce one frame, not one per valuation — that
 * is what lets §31's notification layer raise an alert straight from this event
 * with no de-duplication of its own, and it is a property no amount of reading
 * the code proves.
 *
 * These tests exist because deleting the transition guard left every other test
 * in the repository green.
 */
suite('Risk state transitions (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let realtime: RealtimeService;
  let metrics: MetricsService;
  let sent: SentFrame[];
  let listening: Set<string>;
  let raised: Array<Record<string, unknown>>;

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
    await stack.publishQuote('XAUUSD', BID, ASK);

    sent = [];
    listening = new Set<string>();

    const gateway = {
      listeningAccounts: () => listening,
      /**
       * The drain now asks *which tenant* each listener belongs to, because it
       * runs on a timer and has to open a scope rather than query without one.
       * These tests run in one tenant, so the stub answers with it.
       */
      tenantsOfListeners: () => [
        { tenant: { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG }, accounts: listening },
      ],
      sendToAccount: (
        accountId: string,
        channel: WsChannel,
        event: string,
        data: Record<string, unknown>,
      ) => {
        sent.push({ accountId, channel, event, data });
        return 1;
      },
      onAccountAbandoned: () => () => undefined,
    } as unknown as RealtimeGateway;

    const prismaService = prisma as unknown as PrismaService;
    const config = new ConfigService<Record<string, unknown>, true>({
      // Zero, so every tick values rather than one in every few. The throttle is
      // not what these tests are about, and leaving it on would make them
      // depend on how fast the machine is.
      REALTIME_VALUATION_INTERVAL_MS: 0,
      // Generous, for the same reason: a pass that ran out of budget on a slow
      // machine would defer the very valuation a test is waiting for.
      REALTIME_VALUATION_BUDGET_MS: 10_000,
    } as never);

    /**
     * The notification leg is queued, and Redis is faked here. `raise` never
     * throws by contract — a queue that is briefly unreachable must not fail a
     * stop-out — so a publisher that refuses is exactly the condition these
     * tests should keep passing under.
     */
    raised = [];
    const notifications = {
      raise: async (job: Record<string, unknown>) => {
        raised.push(job);
      },
    } as unknown as NotificationsService;

    metrics = new MetricsService();
    realtime = new RealtimeService(
      config as never,
      prismaService,
      stack.accountState,
      gateway,
      new TickBus(),
      new ExposureIndex(prismaService, new EventsService(fakeRedis), 30_000),
      notifications,
      metrics,
    );
  });

  const tick = (bid: string, ask: string): Tick => ({
    symbol: 'XAUUSD',
    bid,
    ask,
    timestamp: Date.now(),
    volume: '1',
  });

  const riskFrames = () => sent.filter((frame) => frame.event === 'risk.updated');

  /** A small account holding a lot, so a modest move crosses the levels. */
  async function leveragedTrader() {
    const trader = await createAccount(prisma, { balance: '5000' });
    listening.add(trader.accountId);
    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    if (opened.positionId === null) throw new Error('no position opened');
    return { ...trader, positionId: opened.positionId };
  }

  it('says nothing while the account is comfortable', async () => {
    await leveragedTrader();

    realtime.onTick(tick(BID, ASK));
    await realtime.drain();
    realtime.onTick(tick('4583.60', '4583.74'));
    await realtime.drain();

    expect(riskFrames()).toHaveLength(0);
  });

  /**
   * The case the mutation exposed. Ten valuations at the same bad level are one
   * piece of news.
   */
  it('announces a crossing once, not once per valuation', async () => {
    const trader = await leveragedTrader();
    await stack.publishQuote('XAUUSD', '4540.00', '4540.14');

    /**
     * Ten separate passes, not one drain over ten ticks.
     *
     * Coalescing them would make this test pass for the wrong reason — one
     * valuation cannot produce two frames whatever the guard does. Ten
     * valuations at the same bad level is the case that matters, and with the
     * throttle set to zero for this suite that is exactly what this is.
     */
    for (let i = 0; i < 10; i += 1) {
      realtime.onTick(tick('4540.00', '4540.14'));
      await realtime.drain();
    }

    const frames = riskFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.accountId).toBe(trader.accountId);
    expect(frames[0]?.data['previous']).toBe(RiskState.NORMAL);
    expect(frames[0]?.data['state']).not.toBe(RiskState.NORMAL);
  });

  it('announces the way back out again', async () => {
    await leveragedTrader();

    await stack.publishQuote('XAUUSD', '4540.00', '4540.14');
    realtime.onTick(tick('4540.00', '4540.14'));
    await realtime.drain();
    expect(riskFrames()).toHaveLength(1);

    await stack.publishQuote('XAUUSD', BID, ASK);
    realtime.onTick(tick(BID, ASK));
    await realtime.drain();

    const frames = riskFrames();
    expect(frames).toHaveLength(2);
    expect(frames[1]?.data['state']).toBe(RiskState.NORMAL);
    expect(frames[1]?.data['previous']).not.toBe(RiskState.NORMAL);
  });

  /**
   * Deepening from margin call into stop-out territory is a *different* state,
   * and a trader who has already been warned still needs to hear this one.
   */
  it('announces a move from one risk state to a worse one', async () => {
    await leveragedTrader();

    await stack.publishQuote('XAUUSD', '4540.00', '4540.14');
    realtime.onTick(tick('4540.00', '4540.14'));
    await realtime.drain();
    const first = riskFrames();

    await stack.publishQuote('XAUUSD', '4500.00', '4500.14');
    realtime.onTick(tick('4500.00', '4500.14'));
    await realtime.drain();
    const frames = riskFrames();

    if (first[0]?.data['state'] === RiskState.STOP_OUT) {
      // Already at the worst state; a further fall is not new news.
      expect(frames).toHaveLength(1);
    } else {
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[frames.length - 1]?.data['state']).toBe(RiskState.STOP_OUT);
    }
  });

  it('carries the levels it judged against, so the number can be checked', async () => {
    await leveragedTrader();
    await stack.publishQuote('XAUUSD', '4540.00', '4540.14');
    realtime.onTick(tick('4540.00', '4540.14'));
    await realtime.drain();

    const frame = riskFrames()[0];
    expect(frame?.data['marginLevel']).toEqual(expect.any(String));
    expect(frame?.data['stopOutLevelPercent']).toEqual(expect.any(String));
    expect(frame?.data['marginCallLevelPercent']).toEqual(expect.any(String));
  });

  /**
   * The frame reaches whoever is looking. A margin call is precisely the moment
   * a trader is not looking, so it is written down as well — and recovering to
   * NORMAL is not, because a bell that rings for every recovery teaches people
   * to ignore it.
   */
  it('also raises a notice when an account crosses into trouble, and not when it comes back', async () => {
    await leveragedTrader();

    await stack.publishQuote('XAUUSD', '4540.00', '4540.14');
    realtime.onTick(tick('4540.00', '4540.14'));
    await realtime.drain();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.['kind']).toMatch(/^risk\./);
    expect(raised[0]?.['severity']).not.toBe('INFO');
    expect(typeof raised[0]?.['dedupeKey']).toBe('string');

    await stack.publishQuote('XAUUSD', BID, ASK);
    realtime.onTick(tick(BID, ASK));
    await realtime.drain();

    // The recovery produced a frame but no second notice.
    expect(riskFrames()).toHaveLength(2);
    expect(raised).toHaveLength(1);
  });

  it('says nothing at all while the account is comfortable', async () => {
    await leveragedTrader();
    realtime.onTick(tick(BID, ASK));
    await realtime.drain();
    expect(raised).toEqual([]);
  });

  it('still streams the account and P&L frames alongside it', async () => {
    await leveragedTrader();
    realtime.onTick(tick(BID, ASK));
    await realtime.drain();

    expect(sent.filter((frame) => frame.event === 'account.updated').length).toBeGreaterThan(0);
    expect(sent.filter((frame) => frame.event === 'pnl.updated').length).toBeGreaterThan(0);
  });
});
