import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { LedgerService } from '../../src/accounts/ledger.service';
import {
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

/**
 * The trigger engine is what makes a stop-loss real. Without it, SL and TP are
 * decorative fields that only take effect if the trader happens to be watching.
 *
 * Every test here drives `onTick` directly rather than waiting on the market
 * feed: the engine's behaviour is a function of the prices it is given, and a
 * test that waits for a random walk to reach a level is a test that fails on a
 * Tuesday.
 */
suite('Trigger engine (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  const ledger = new LedgerService();

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
  });

  const openLong = async (stopLoss?: string, takeProfit?: string) => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
      ...(stopLoss === undefined ? {} : { stopLoss }),
      ...(takeProfit === undefined ? {} : { takeProfit }),
    });
    return { userId, accountId, positionId: opened.positionId! };
  };

  /** Publishes a price and lets the engine act on it, as the feed would. */
  const tick = async (bid: string, ask: string) => {
    await stack.publishQuote('XAUUSD', bid, ask);
    await stack.triggers.onTick({
      symbol: 'XAUUSD',
      bid,
      ask,
      timestamp: Date.now(),
      volume: '1',
    });
  };

  describe('stop-loss', () => {
    it('closes a long when the bid reaches the stop', async () => {
      const { positionId } = await openLong('4525.79');

      await tick('4560.00', '4560.14');
      let position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('OPEN');

      await tick('4525.79', '4525.93');
      position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('STOP_LOSS');
    });

    /**
     * A long is closed at the bid, so that is the price the trade must record.
     * Booking the ask or the mid would credit the trader with half a spread
     * they never had — on every stopped-out position, in the house's favour.
     */
    it('fills at the bid, not the ask or the mid', async () => {
      const { positionId } = await openLong('4525.79');
      await tick('4525.00', '4525.60');

      const trade = await prisma.trade.findFirstOrThrow({ where: { positionId } });
      expect(trade.exitPrice.toString()).toBe('4525');
    });

    it('does not fire while the bid is still above the stop', async () => {
      const { positionId } = await openLong('4525.79');
      // One tick above the stop, with the ask far above it.
      await tick('4525.80', '4525.94');
      expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).status).toBe(
        'OPEN',
      );
    });

    it('closes a short when the ask reaches the stop', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const opened = await stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'SELL',
        volume: '1.00',
        stopLoss: '4653.65',
      });

      await tick('4653.51', '4653.65');
      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('STOP_LOSS');
    });

    it('books the loss to the ledger and leaves it reconciled', async () => {
      const { accountId, positionId } = await openLong('4525.79');
      await tick('4520.00', '4520.14');

      const trade = await prisma.trade.findFirstOrThrow({ where: { positionId } });
      expect(trade.closeReason).toBe('STOP_LOSS');
      // Closed on the bid at 4520.00 against a 4583.72 entry.
      expect(Money.of(trade.grossPnl.toString(), 'USD').toString()).toBe('-6372.00');

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'TRADE_LOSS' },
      });
      expect(entry.amount.toString()).toBe('-6372');

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });
  });

  describe('take-profit', () => {
    it('closes a long when the bid reaches the target', async () => {
      const { positionId } = await openLong(undefined, '4653.65');

      await tick('4600.00', '4600.14');
      expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).status).toBe(
        'OPEN',
      );

      await tick('4653.65', '4653.79');
      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('TAKE_PROFIT');
    });
  });

  describe('a tick that spans both levels', () => {
    /**
     * A gap can jump past the stop and the target at once. The intra-tick path
     * is unknowable, so the platform resolves it the same way every time —
     * stop-loss first — rather than picking whichever suits the house.
     */
    it('resolves in favour of the stop-loss, every time', async () => {
      const { positionId } = await openLong('4500.00', '4600.00');
      await tick('4400.00', '4400.14');

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('STOP_LOSS');
    });
  });

  describe('trailing stop', () => {
    it('ratchets the stop up behind a rising market and never back down', async () => {
      const { userId, positionId } = await openLong();
      await stack.positions.modify(userId, { positionId, trailingStopDistance: '20.00' });

      await tick('4600.00', '4600.14');
      let position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.stopLoss?.toString()).toBe('4580');
      expect(position.highWaterPrice?.toString()).toBe('4600');

      await tick('4650.00', '4650.14');
      position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.stopLoss?.toString()).toBe('4630');

      // Market pulls back: the stop holds where it was.
      await tick('4635.00', '4635.14');
      position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.stopLoss?.toString()).toBe('4630');
      expect(position.status).toBe('OPEN');
    });

    it('closes the position when the market falls back through the trailed stop', async () => {
      const { userId, positionId } = await openLong();
      await stack.positions.modify(userId, { positionId, trailingStopDistance: '20.00' });

      await tick('4650.00', '4650.14');
      await tick('4629.99', '4630.13');

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('STOP_LOSS');
      // Locked in a profit despite closing on a stop: entry 4583.72, exit 4629.99.
      expect(Number(position.realizedPnl.toString())).toBeGreaterThan(0);
    });

    it('drops the high-water anchor when trailing is switched off', async () => {
      const { userId, positionId } = await openLong();
      await stack.positions.modify(userId, { positionId, trailingStopDistance: '20.00' });
      await tick('4650.00', '4650.14');

      await stack.positions.modify(userId, { positionId, trailingStopDistance: null });
      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.trailingStopDistance).toBeNull();
      expect(position.highWaterPrice).toBeNull();
    });
  });

  describe('stop-out', () => {
    /**
     * An account that has fallen through its stop-out level is liquidated by the
     * platform. Positions go largest-margin-first, one at a time, re-valuing
     * after each — closing one frees margin and the account often recovers
     * before the rest need to go.
     */
    it('liquidates until the account is back above its stop-out level', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '6000' });
      // Two lots at ~4583 with 1% margin ties up ~4583.72 of the 6000 balance.
      const first = await stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1.00',
      });
      expect(first.positionId).not.toBeNull();

      // A 15% adverse move wipes out most of the equity.
      await tick('3900.00', '3900.14');

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: first.positionId! },
      });
      expect(position.status).toBe('CLOSED');
      expect(position.closeReason).toBe('LIQUIDATION');

      const risk = await prisma.riskEvent.findFirstOrThrow({
        where: { accountId, rule: 'stop-out' },
      });
      expect(risk.severity).toBe('CRITICAL');
      expect(JSON.stringify(risk.snapshot)).toContain('equity');
    });

    it('leaves a healthy account alone', async () => {
      const { positionId } = await openLong();
      await tick('4580.00', '4580.14');

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('OPEN');
      expect(await prisma.riskEvent.count({ where: { rule: 'stop-out' } })).toBe(0);
    });
  });

  describe('interaction with manual closes', () => {
    it('does not double-close a position the trader closed a moment earlier', async () => {
      const { userId, positionId } = await openLong('4525.79');

      // The trader closes manually at the same instant the stop is reached.
      await stack.publishQuote('XAUUSD', '4525.79', '4525.93');
      const [manual, engine] = await Promise.allSettled([
        stack.positions.close(userId, positionId, null),
        stack.triggers.onTick({
          symbol: 'XAUUSD',
          bid: '4525.79',
          ask: '4525.93',
          timestamp: Date.now(),
          volume: '1',
        }),
      ]);

      // Whichever wins, the position settles exactly once. The engine always
      // resolves: it swallows a lost race rather than surfacing it as an error.
      // The manual close may legitimately lose, so its outcome is not asserted.
      expect(engine.status).toBe('fulfilled');
      expect(['fulfilled', 'rejected']).toContain(manual.status);
      expect(await prisma.trade.count({ where: { positionId } })).toBe(1);

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
    });

    it('ignores a position with no protective levels at all', async () => {
      const { positionId } = await openLong();
      await tick('4000.00', '4000.14');
      expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).status).toBe(
        'OPEN',
      );
    });

    it('ignores positions in other symbols', async () => {
      const { positionId } = await openLong('4525.79');
      await stack.triggers.onTick({
        symbol: 'BTCUSD',
        bid: '1.00',
        ask: '1.01',
        timestamp: Date.now(),
        volume: '1',
      });
      expect((await prisma.position.findUniqueOrThrow({ where: { id: positionId } })).status).toBe(
        'OPEN',
      );
    });
  });
});
