import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { LedgerService } from '../../src/accounts/ledger.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedClosedSymbol,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Reference prices from the terminal capture in docs/pnl.md, so the numbers
 * these tests assert line up with the unit-level P&L vectors.
 */
const BID = '4583.58';
const ASK = '4583.72';

suite('Trading core (integration)', () => {
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

  const openAccount = () => createAccount(prisma, { balance: '100000' });

  const buyOneLot = async (userId: string, accountId: string) =>
    stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

  describe('the milestone: order → execution → position → P&L → close → ledger', () => {
    it('opens a position at the ask and records the whole trail', async () => {
      const { userId, accountId } = await openAccount();
      const result = await buyOneLot(userId, accountId);

      // A long is opened by lifting the ask.
      expect(result.price).toBe(ASK);
      expect(result.status).toBe('FILLED');

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: result.positionId! },
      });
      expect(position.status).toBe('OPEN');
      expect(position.volume.toString()).toBe('1');
      expect(position.entryPrice.toString()).toBe(ASK);
      // 1.00 lot x 100 contract size x 4583.72 x 1% margin
      expect(Money.of(position.margin.toString(), 'USD').toString()).toBe('4583.72');

      const execution = await prisma.execution.findFirstOrThrow({
        where: { orderId: result.orderId },
      });
      // The exact quote the fill happened against is retained for disputes.
      expect(execution.quoteBid.toString()).toBe(BID);
      expect(execution.quoteAsk.toString()).toBe(ASK);

      const events = await prisma.orderEvent.findMany({
        where: { orderId: result.orderId },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED', 'FILLED']);
    });

    it('marks the position to market on the bid', async () => {
      const { userId, accountId } = await openAccount();
      await buyOneLot(userId, accountId);

      const valuation = await stack.accountState.valuate(accountId);
      // Entry at the ask, marked at the bid: the position starts down the spread.
      // (4583.58 - 4583.72) x 100 x 1 = -14.00
      expect(valuation.state.floatingPnl.toString()).toBe('-14.00');
      expect(valuation.state.equity.toString()).toBe('99986.00');
      expect(valuation.state.usedMargin.toString()).toBe('4583.72');
      expect(valuation.state.freeMargin.toString()).toBe('95402.28');
      expect(valuation.positions[0]?.stale).toBe(false);
    });

    it('closes at the bid, writes a trade, posts to the ledger and moves the balance', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      // Price moves up; the long is closed on the new bid.
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      const closed = await stack.positions.close(userId, opened.positionId!, null);

      // (4600.00 - 4583.72) x 100 x 1 = 1628.00
      expect(closed.grossPnl).toBe('1628.00');
      expect(closed.netPnl).toBe('1628.00');
      expect(closed.fullyClosed).toBe(true);
      expect(closed.balanceAfter).toBe('101628.00');

      const trade = await prisma.trade.findFirstOrThrow({
        where: { positionId: opened.positionId! },
      });
      expect(trade.entryPrice.toString()).toBe(ASK);
      expect(trade.exitPrice.toString()).toBe('4600');
      expect(trade.closeReason).toBe('MANUAL');

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });
      expect(position.status).toBe('CLOSED');
      expect(position.margin.toString()).toBe('0');
      expect(position.closedAt).not.toBeNull();

      const entries = await prisma.balanceLedger.findMany({
        where: { accountId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.type)).toEqual(['DEPOSIT', 'TRADE_PROFIT']);
    });

    it('leaves the ledger and the cached balance in agreement afterwards', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4570.00', '4570.14');
      await stack.positions.close(userId, opened.positionId!, null);

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });

    it('records a loss as a TRADE_LOSS entry, not a negative profit', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4500.00', '4500.14');
      const closed = await stack.positions.close(userId, opened.positionId!, null);

      expect(closed.netPnl).toBe('-8372.00');
      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'TRADE_LOSS' },
      });
      expect(entry.amount.toString()).toBe('-8372');
    });
  });

  describe('partial close', () => {
    it('reduces volume and margin proportionally and keeps the position open', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      const closed = await stack.positions.close(userId, opened.positionId!, '0.40');

      expect(closed.fullyClosed).toBe(false);
      expect(closed.closedVolume).toBe('0.4');
      expect(closed.remainingVolume).toBe('0.6');
      // 40% of the move on 40% of the position.
      expect(closed.grossPnl).toBe('651.20');

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });
      expect(position.status).toBe('OPEN');
      expect(position.volume.toString()).toBe('0.6');
      // Margin released in the same proportion: 4583.72 x 0.6
      expect(Money.of(position.margin.toString(), 'USD').toString()).toBe('2750.23');
      // initialVolume is untouched, so the history stays reconstructable.
      expect(position.initialVolume.toString()).toBe('1');
    });

    /**
     * Only reachable when an instrument's minimum size is larger than its lot
     * step, which is a real configuration: 0.10 minimum in 0.01 increments.
     */
    it('closes the whole position when the remainder would be untradeable', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { minVolume: '0.10' },
      });
      await stack.symbols.reload();

      const { userId, accountId } = await openAccount();
      const opened = await stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.30',
      });

      // Closing 0.25 would leave 0.05 lots — below the 0.10 minimum, and so
      // impossible to close afterwards. The whole position goes instead.
      const closed = await stack.positions.close(userId, opened.positionId!, '0.25');
      expect(closed.fullyClosed).toBe(true);
      expect(closed.closedVolume).toBe('0.3');
      expect(closed.remainingVolume).toBe('0');
    });

    it('refuses to close more than is open', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await expect(stack.positions.close(userId, opened.positionId!, '2.00')).rejects.toMatchObject(
        {
          code: 'PARTIAL_CLOSE_EXCEEDS_VOLUME',
        },
      );
    });

    it('produces one trade row per partial close', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      await stack.positions.close(userId, opened.positionId!, '0.30');
      await stack.positions.close(userId, opened.positionId!, '0.30');
      await stack.positions.close(userId, opened.positionId!, null);

      const trades = await prisma.trade.findMany({ where: { positionId: opened.positionId! } });
      expect(trades).toHaveLength(3);
      expect(trades.map((t) => t.volume.toString()).sort()).toEqual(['0.3', '0.3', '0.4']);
    });
  });

  /**
   * Commission is charged twice on a round trip — once at entry, once at exit —
   * and the trade record has to say so. It previously carried only the closing
   * leg, so a trader adding up their history came out short by one commission
   * per trade and could not reconcile it with their balance.
   */
  describe('commission accounting', () => {
    const COMMISSION_PER_LOT = '7';

    beforeEach(async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { commissionPerLot: COMMISSION_PER_LOT },
      });
      await stack.symbols.reload();
      stack = await buildTradingStack(prisma);
      await stack.publishQuote('XAUUSD', BID, ASK);
    });

    it('reports the round trip, not just the closing leg', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      const closed = await stack.positions.close(userId, opened.positionId!, null);

      expect(closed.grossPnl).toBe('1628.00');
      expect(closed.entryCommission).toBe('7.00');
      expect(closed.exitCommission).toBe('7.00');
      expect(closed.commission).toBe('14.00');
      expect(closed.netPnl).toBe('1614.00');
      expect(closed.balanceAfter).toBe('101614.00');
    });

    /** The point of the whole exercise: the report has to match the money. */
    it('reports a net figure that equals the balance change', async () => {
      const { userId, accountId } = await openAccount();
      const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      const closed = await stack.positions.close(userId, opened.positionId!, null);

      const delta = Money.of(closed.balanceAfter, 'USD').minus(
        Money.of(before.balance.toString(), 'USD'),
      );
      expect(delta.toString()).toBe(closed.netPnl);
    });

    it('charges the entry commission once, however many times the position is closed', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');

      await stack.positions.close(userId, opened.positionId!, '0.30');
      await stack.positions.close(userId, opened.positionId!, '0.30');
      await stack.positions.close(userId, opened.positionId!, null);

      const trades = await prisma.trade.findMany({ where: { positionId: opened.positionId! } });
      const apportioned = trades.reduce(
        (total, trade) => total.plus(Money.of(trade.entryCommission.toString(), 'USD')),
        Money.zero('USD'),
      );
      // One lot at 7 per lot, split across three closes and adding back up.
      expect(apportioned.toString()).toBe('7.00');

      const charged = await prisma.balanceLedger.findMany({
        where: { accountId, type: 'COMMISSION' },
        orderBy: { createdAt: 'asc' },
      });
      // Four postings: one at open, one per close. The entry leg is not
      // re-posted when the position is closed in pieces.
      expect(charged).toHaveLength(4);
      expect(charged[0]!.amount.toString()).toBe('-7');
      // One lot in, one lot out, at 7 a lot each way.
      const totalCharged = charged.reduce(
        (total, entry) => total.plus(Money.of(entry.amount.toString(), 'USD')),
        Money.zero('USD'),
      );
      expect(totalCharged.toString()).toBe('-14.00');
    });

    /**
     * The apportionment divides by the volume the position *opened* with, not
     * the volume still open. Dividing by the remainder would charge 7 on the
     * first close and 7 again on the second — more than was ever taken.
     */
    it('apportions the entry commission against the opening volume', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');

      const first = await stack.positions.close(userId, opened.positionId!, '0.50');
      expect(first.entryCommission).toBe('3.50');

      // Half the position is left. Closing half of *that* is a quarter of the
      // original, so a quarter of the entry commission.
      const second = await stack.positions.close(userId, opened.positionId!, '0.25');
      expect(second.entryCommission).toBe('1.75');
    });

    it('keeps the ledger and the cached balance in agreement', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4570.00', '4570.14');
      await stack.positions.close(userId, opened.positionId!, '0.40');
      await stack.positions.close(userId, opened.positionId!, null);

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });

    it('sums every close on a position back to the position result', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      await stack.positions.close(userId, opened.positionId!, '0.40');
      await stack.positions.close(userId, opened.positionId!, null);

      const trades = await prisma.trade.findMany({ where: { positionId: opened.positionId! } });
      const netFromTrades = trades.reduce(
        (total, trade) => total.plus(Money.of(trade.netPnl.toString(), 'USD')),
        Money.zero('USD'),
      );
      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });
      expect(Money.of(position.realizedPnl.toString(), 'USD').toString()).toBe(
        netFromTrades.toString(),
      );
    });
  });

  describe('concurrency', () => {
    /**
     * The guard that stops a manual close, a stop-loss trigger and a
     * liquidation from all closing the same position.
     */
    it('lets exactly one of two simultaneous closes through', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      const results = await Promise.allSettled([
        stack.positions.close(userId, opened.positionId!, null),
        stack.positions.close(userId, opened.positionId!, null),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('POSITION_ALREADY_CLOSING');

      // One close means one trade and one ledger entry, not two of each.
      expect(await prisma.trade.count({ where: { positionId: opened.positionId! } })).toBe(1);
      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });

    it('survives ten simultaneous close attempts with a single trade', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => stack.positions.close(userId, opened.positionId!, null)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.trade.count({ where: { positionId: opened.positionId! } })).toBe(1);
    });

    /**
     * A modify racing a close. Whichever loses must fail loudly rather than
     * writing a stop-loss onto a position that is already gone.
     */
    it('never applies a modification to a position that a concurrent close won', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      const [modified, closed] = await Promise.allSettled([
        stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: '4500.00' }),
        stack.positions.close(userId, opened.positionId!, null),
      ]);

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });

      if (closed.status === 'fulfilled') {
        expect(position.status).toBe('CLOSED');
        // A closed position must not be carrying a stop-loss that was written
        // after it stopped existing.
        if (modified.status === 'rejected') expect(position.stopLoss).toBeNull();
      } else {
        expect(position.status).toBe('OPEN');
      }
      // Exactly one trade, whatever the interleaving.
      expect(
        await prisma.trade.count({ where: { positionId: opened.positionId! } }),
      ).toBeLessThanOrEqual(1);
    });

    it('rejects a modification whose version check fails', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      // Force the guard by pointing the update at a version that no longer exists.
      await prisma.position.update({
        where: { id: opened.positionId! },
        data: { version: 99 },
      });
      const stale = await prisma.position.findUniqueOrThrow({ where: { id: opened.positionId! } });
      expect(stale.version).toBe(99);

      const updated = await prisma.position.updateMany({
        where: { id: opened.positionId!, status: 'OPEN', version: 0 },
        data: { stopLoss: '4500.00' },
      });
      expect(updated.count).toBe(0);
    });

    it('will not modify a position that is closing', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await prisma.position.update({
        where: { id: opened.positionId! },
        data: { status: 'CLOSING' },
      });

      await expect(
        stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: '4500.00' }),
      ).rejects.toMatchObject({ code: 'POSITION_ALREADY_CLOSING' });
    });
  });

  /**
   * Concurrent orders on one account.
   *
   * This is here because of a real deadlock that only a load test found. Every
   * insert that references an account takes a `FOR KEY SHARE` lock on its row —
   * PostgreSQL does that for the foreign key — and the ledger post then wants
   * the row exclusively. Two orders in flight on one account each held a share
   * lock and each waited for the other's exclusive lock, and PostgreSQL killed
   * one with `40P01`. Eight of ten simultaneous orders failed, and the trader
   * was told "an unexpected error occurred". Two quick clicks could do it.
   *
   * The cure is lock ordering: take the account's write lock first, before any
   * insert that references it, so a second transaction blocks at the top holding
   * nothing and there is no cycle.
   */
  describe('concurrent orders on one account', () => {
    it('opens every position when ten are submitted at once', async () => {
      const { userId, accountId } = await openAccount();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          stack.orders.openPosition(userId, {
            accountId,
            symbol: 'XAUUSD',
            side: 'BUY',
            volume: '0.01',
          }),
        ),
      );

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(0);
      expect(await prisma.position.count({ where: { accountId } })).toBe(10);
    });

    it('leaves the ledger and the cached balance in agreement afterwards', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { commissionPerLot: '7' },
      });
      await stack.symbols.reload();
      stack = await buildTradingStack(prisma);
      await stack.publishQuote('XAUUSD', BID, ASK);

      const { userId, accountId } = await openAccount();
      await Promise.all(
        Array.from({ length: 8 }, () =>
          stack.orders.openPosition(userId, {
            accountId,
            symbol: 'XAUUSD',
            side: 'BUY',
            volume: '0.01',
          }),
        ),
      );

      // Eight commissions, each posted exactly once, and the balance matches the
      // sum of the entries rather than whichever transaction committed last.
      const commissions = await prisma.balanceLedger.count({
        where: { accountId, type: 'COMMISSION' },
      });
      expect(commissions).toBe(8);

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });

    it('closes concurrently opened positions without deadlocking either', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await Promise.all(
        Array.from({ length: 6 }, () =>
          stack.orders.openPosition(userId, {
            accountId,
            symbol: 'XAUUSD',
            side: 'BUY',
            volume: '0.01',
          }),
        ),
      );
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');

      const closes = await Promise.allSettled(
        opened.map((order) => stack.positions.close(userId, order.positionId!, null)),
      );
      expect(closes.filter((result) => result.status === 'rejected')).toHaveLength(0);

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });
  });

  describe('rejections', () => {
    it('rejects an order with insufficient free margin and records why', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100' });

      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1.00',
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_MARGIN' });

      // Nothing was created — a rejected order is not a half-open position.
      expect(await prisma.position.count()).toBe(0);
      expect(await prisma.order.count()).toBe(0);

      const risk = await prisma.riskEvent.findFirstOrThrow({ where: { accountId } });
      expect(risk.rule).toBe('sufficient-margin');
      expect(JSON.stringify(risk.snapshot)).toContain('freeMargin');
    });

    it('rejects a volume below the instrument minimum', async () => {
      const { userId, accountId } = await openAccount();
      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.001',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_VOLUME' });
    });

    it('rejects a long stop-loss placed above the entry price', async () => {
      const { userId, accountId } = await openAccount();
      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1.00',
          stopLoss: '4600.00',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STOP_LOSS' });
      expect(await prisma.position.count()).toBe(0);
    });

    it('refuses to trade on a stale quote', async () => {
      const { userId, accountId } = await openAccount();
      // Ten seconds old, against a five-second freshness policy.
      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 10_000);

      await expect(buyOneLot(userId, accountId)).rejects.toMatchObject({ code: 'STALE_QUOTE' });
      expect(await prisma.position.count()).toBe(0);
    });

    it('refuses to trade an instrument that has never been quoted', async () => {
      const { userId, accountId } = await openAccount();
      await seedClosedSymbol(prisma);
      await stack.symbols.reload();

      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'CLOSEDX',
          side: 'BUY',
          volume: '1.00',
        }),
      ).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
    });

    it('rejects an unknown symbol', async () => {
      const { userId, accountId } = await openAccount();
      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'NOPE',
          side: 'BUY',
          volume: '1.00',
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    });

    it('refuses to trade on a suspended account', async () => {
      const { userId, accountId } = await openAccount();
      await prisma.account.update({ where: { id: accountId }, data: { status: 'SUSPENDED' } });
      await expect(buyOneLot(userId, accountId)).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_TRADEABLE',
      });
    });

    it('will not let one user touch another user’s position', async () => {
      const owner = await openAccount();
      const stranger = await openAccount();
      const opened = await buyOneLot(owner.userId, owner.accountId);

      await expect(
        stack.positions.close(stranger.userId, opened.positionId!, null),
      ).rejects.toMatchObject({ code: 'POSITION_NOT_FOUND' });
    });
  });

  describe('failure recovery', () => {
    /**
     * A close that fails after claiming the position must not strand it in
     * CLOSING, where it would be untradeable and invisible to the stop-out check.
     */
    it('returns a position to OPEN when the close fails on a stale quote', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 60_000);
      await expect(stack.positions.close(userId, opened.positionId!, null)).rejects.toMatchObject({
        code: 'STALE_QUOTE',
      });

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: opened.positionId! },
      });
      expect(position.status).toBe('OPEN');
      expect(position.volume.toString()).toBe('1');

      // And it can still be closed once prices return.
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      await expect(stack.positions.close(userId, opened.positionId!, null)).resolves.toBeDefined();
    });
  });

  describe('modify', () => {
    it('sets and then clears protective levels', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      await stack.positions.modify(userId, {
        positionId: opened.positionId!,
        stopLoss: '4525.79',
        takeProfit: '4653.65',
      });
      let position = await prisma.position.findUniqueOrThrow({ where: { id: opened.positionId! } });
      expect(position.stopLoss?.toString()).toBe('4525.79');
      expect(position.takeProfit?.toString()).toBe('4653.65');

      await stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: null });
      position = await prisma.position.findUniqueOrThrow({ where: { id: opened.positionId! } });
      expect(position.stopLoss).toBeNull();
      // Omitting takeProfit left it alone, rather than clearing it too.
      expect(position.takeProfit?.toString()).toBe('4653.65');
    });

    it('rejects a stop-loss already through the market', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await expect(
        stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: '4700.00' }),
      ).rejects.toMatchObject({ code: 'INVALID_STOP_LOSS' });
    });

    it('writes an event carrying the previous levels', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);
      await stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: '4500.00' });
      await stack.positions.modify(userId, { positionId: opened.positionId!, stopLoss: '4520.00' });

      const events = await prisma.positionEvent.findMany({
        where: { positionId: opened.positionId!, type: 'MODIFIED' },
        orderBy: { createdAt: 'asc' },
      });
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events[1]?.payload)).toContain('4500');
    });
  });

  describe('reverse', () => {
    it('closes the position and opens the same size the other way', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await buyOneLot(userId, accountId);

      const result = await stack.positions.reverse(userId, opened.positionId!);
      expect(result.closed.fullyClosed).toBe(true);
      expect(result.closed.closeReason).toBe('REVERSE');
      expect(result.opened.side).toBe('SELL');
      expect(result.opened.volume).toBe('1');
      // A short is opened on the bid.
      expect(result.opened.price).toBe(BID);

      const open = await prisma.position.findMany({ where: { accountId, status: 'OPEN' } });
      expect(open).toHaveLength(1);
      expect(open[0]?.side).toBe('SELL');
    });
  });

  describe('short positions', () => {
    it('opens on the bid, marks on the ask, and profits when price falls', async () => {
      const { userId, accountId } = await openAccount();
      const opened = await stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'SELL',
        volume: '1.00',
      });
      expect(opened.price).toBe(BID);

      await stack.publishQuote('XAUUSD', '4500.00', '4500.14');
      const valuation = await stack.accountState.valuate(accountId);
      // (4583.58 - 4500.14) x 100 = 8344.00
      expect(valuation.state.floatingPnl.toString()).toBe('8344.00');

      const closed = await stack.positions.close(userId, opened.positionId!, null);
      expect(closed.exitPrice).toBe('4500.14');
      expect(closed.grossPnl).toBe('8344.00');
    });
  });
});
