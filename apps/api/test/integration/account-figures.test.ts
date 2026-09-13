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
 * The figures the account strip shows.
 *
 * All of them are computed by the server and none by the browser, which is the
 * point: a number a trader can see but the server never produced is a number
 * nobody can reconcile after a dispute. So they are tested where they are
 * produced.
 */
suite('Account figures (integration)', () => {
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

  async function openAndClose(userId: string, accountId: string) {
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');
    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
    return stack.positions.close(userId, opened.positionId, null);
  }

  /**
   * Realized P&L is summed from `trades`, and put on a trader's screen. If it
   * does not tie to the ledger, it is a number nobody can reconcile after a
   * dispute — which is the one thing this system is not allowed to display.
   *
   * The commission is set so that a leg costs 0.175: exactly the sub-cent case
   * the seeded test instruments miss, because they charge no commission at all.
   * That gap is why the ledger's double-rounding survived until it was found by
   * reading a real account's entries.
   */
  it('ties a round trip in trades to the ledger entries it produced', async () => {
    await prisma.symbolSpec.updateMany({ data: { commissionPerLot: '3.50' } });
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', BID, ASK);

    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.05',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');
    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
    await stack.positions.close(userId, opened.positionId, null);

    const trade = await prisma.trade.findFirstOrThrow({ where: { positionId: opened.positionId } });
    const entries = await prisma.balanceLedger.findMany({
      where: { referenceId: opened.positionId },
    });
    expect(entries.length).toBeGreaterThan(1);

    // Every entry this position caused, both legs, summed.
    const moved = entries.reduce((total, entry) => total + Number(entry.amount), 0);
    expect(Number(trade.netPnl)).toBeCloseTo(moved, 10);

    // And the balance itself moved by exactly that much.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(account.balance)).toBeCloseTo(100_000 + moved, 10);
  });

  /**
   * The same tie, but closed in pieces.
   *
   * The entry commission was charged once, on the whole position, and each
   * partial close reports a share of it. Rounding each share on its own is the
   * obvious thing to do and quietly invents money: three closes of a third of a
   * 0.05 commission round to 0.02 apiece and sum to 0.06 — a cent that was never
   * charged, appearing in a report as though it had been. The final close takes
   * the remainder instead, so the shares sum to the charge exactly.
   */
  it('ties a position closed in pieces to the ledger, with no invented cent', async () => {
    await prisma.symbolSpec.updateMany({ data: { commissionPerLot: '3.50' } });
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', BID, ASK);

    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.15',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');

    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
    await stack.positions.close(userId, opened.positionId, '0.05');
    await stack.positions.close(userId, opened.positionId, '0.05');
    await stack.positions.close(userId, opened.positionId, null);

    const trades = await prisma.trade.findMany({ where: { positionId: opened.positionId } });
    expect(trades).toHaveLength(3);

    const entries = await prisma.balanceLedger.findMany({
      where: { referenceId: opened.positionId },
    });
    const moved = entries.reduce((total, entry) => total + Number(entry.amount), 0);
    const reported = trades.reduce((total, trade) => total + Number(trade.netPnl), 0);
    expect(reported).toBeCloseTo(moved, 10);

    // The shares of the entry commission sum to what was actually charged —
    // no more, and none of it lost.
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: opened.positionId },
    });
    const apportioned = trades.reduce((total, trade) => total + Number(trade.entryCommission), 0);
    const chargedAtOpen = entries
      .filter((entry) => entry.description?.includes('opening') === true)
      .reduce((total, entry) => total + Math.abs(Number(entry.amount)), 0);
    expect(apportioned).toBeCloseTo(chargedAtOpen, 10);
    expect(apportioned).toBeCloseTo(Number(position.commission), 10);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(account.balance)).toBeCloseTo(100_000 + moved, 10);
  });

  /**
   * A break-even round trip is still a round trip.
   *
   * This one is here because a smoke test caught it and no unit test would
   * have. Rounding the gross P&L once, correctly, made a 0.01-lot scalp inside
   * the spread land on exactly zero — and the ledger posting was guarded by
   * `if (!gross.isZero())`, so the trade produced no entry at all. Every
   * break-even trade would have read as a reconciliation mismatch for ever.
   */
  it('writes a ledger entry for a trade that made nothing', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.01',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');

    // A BUY opens at the ask and closes at the bid, so quoting a bid equal to
    // the entry price makes the result exactly zero — deliberately, rather than
    // by hoping some volume and spread happen to round to nothing.
    await stack.publishQuote('XAUUSD', ASK, '4583.86');
    await stack.positions.close(userId, opened.positionId, null);

    const trade = await prisma.trade.findFirstOrThrow({ where: { positionId: opened.positionId } });
    expect(Number(trade.grossPnl)).toBe(0);

    const entries = await prisma.balanceLedger.findMany({
      where: { referenceId: opened.positionId },
    });
    expect(entries.some((entry) => entry.type.startsWith('TRADE_'))).toBe(true);
  });

  it('reports realized P&L equal to the trades that produced it', async () => {
    const { userId, accountId, currency } = await createAccount(prisma, { balance: '100000' });
    await openAndClose(userId, accountId);
    await openAndClose(userId, accountId);

    const trades = await prisma.trade.findMany({ where: { accountId } });
    expect(trades).toHaveLength(2);
    const expected = trades.reduce((sum, trade) => sum + Number(trade.netPnl), 0).toFixed(2);

    const realized = await stack.accountState.realized(accountId, currency);
    expect(Number(realized.today).toFixed(2)).toBe(expected);
    expect(Number(realized.total).toFixed(2)).toBe(expected);
  });

  /**
   * The mistake this test exists to prevent.
   *
   * Realized P&L is easy to "derive" from the balance — it is right there, and
   * it moves when a trade closes. It also moves when somebody deposits, and a
   * profit figure that counts a deposit is worse than no profit figure at all.
   * So it comes from `trades` and nowhere else.
   */
  it('does not count a deposit as profit', async () => {
    const { userId, accountId, currency } = await createAccount(prisma, { balance: '100000' });
    await openAndClose(userId, accountId);
    const beforeDeposit = await stack.accountState.realized(accountId, currency);

    await prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, accountId);
      await ledger.post(tx, {
        accountId,
        type: 'DEPOSIT',
        amount: Money.of('50000', currency),
        description: 'a deposit, which is not a profit',
      });
    });

    const afterDeposit = await stack.accountState.realized(accountId, currency);
    expect(afterDeposit.total.toString()).toBe(beforeDeposit.total.toString());

    // And the balance did move, so the test is checking something.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Number(account.balance)).toBeGreaterThan(140_000);
  });

  it('counts nothing before the first trade, rather than failing', async () => {
    const { accountId, currency } = await createAccount(prisma, { balance: '100000' });
    const realized = await stack.accountState.realized(accountId, currency);
    expect(realized.today.toString()).toBe('0.00');
    expect(realized.total.toString()).toBe('0.00');
  });

  /**
   * A trade closed before today counts in the lifetime figure and not in the
   * daily one.
   *
   * Tested by moving **the clock**, not the trade. `realized()` takes `nowMs`,
   * so the same closed trade can be asked about from a later day — which is
   * what actually happens in production, where the trade stays put and the day
   * rolls over.
   *
   * It used to drag the trade's `exitTime` backwards with an `updateMany`, and
   * that only changed when `trades` became append-only at the database and the
   * statement started being refused. The rewrite is better than what it
   * replaced: a trade written by the service and then asked about later is the
   * real scenario, where a trade edited into the past is a fiction that happens
   * to produce the same numbers. Worth recording, because the constraint
   * improved the test rather than costing it anything.
   */
  it('separates today from the account lifetime', async () => {
    const { userId, accountId, currency } = await createAccount(prisma, { balance: '100000' });
    await openAndClose(userId, accountId);

    const before = await stack.accountState.realized(accountId, currency);
    expect(before.today.toString()).toBe(before.total.toString());
    expect(Number(before.total)).not.toBe(0);

    // A full day past the boundary this trade was counted in, so the question
    // is asked from the far side of at least one daily reset.
    const nextDay = before.since + 25 * 60 * 60 * 1000;
    const after = await stack.accountState.realized(accountId, currency, nextDay);
    expect(after.today.toString(), 'yesterday’s profit is not today’s').toBe('0.00');
    expect(after.total.toString(), 'but the lifetime figure keeps it').toBe(
      before.total.toString(),
    );
  });

  it('reports exposure and margin utilisation from the same valuation', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });

    const valuation = await stack.accountState.valuate(accountId);
    const dto = stack.accountState.toDto(valuation) as Record<string, string>;

    // One lot of gold at ~4583 with a contract size of 100 is ~458,000 of
    // notional — far more than the account's equity, which is exactly the fact
    // an exposure figure exists to make visible.
    expect(Number(dto['grossExposure'])).toBeGreaterThan(400_000);

    // Utilisation is used margin over equity, as a percentage.
    const expected = ((Number(dto['usedMargin']) / Number(dto['equity'])) * 100).toFixed(2);
    expect(dto['marginUtilisation']).toBe(expected);
  });

  it('reports zero utilisation and zero exposure with nothing committed', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const dto = stack.accountState.toDto(await stack.accountState.valuate(accountId));
    // Zero, not null: the account has equity and none of it is committed, which
    // is a real answer rather than a missing one.
    expect(dto['marginUtilisation']).toBe('0');
    expect(dto['grossExposure']).toBe('0.00');
  });

  /**
   * A ratio over a non-positive denominator is not a percentage. Rendering one
   * would be worse than rendering nothing, so the server sends `null` and the
   * terminal shows "n/a" rather than a number that means nothing.
   */
  it('reports no utilisation at all when there is no equity to divide by', async () => {
    const { accountId } = await createAccount(prisma);
    const dto = stack.accountState.toDto(await stack.accountState.valuate(accountId));
    expect(dto['equity']).toBe('0.00');
    expect(dto['marginUtilisation']).toBeNull();
  });

  /**
   * A position's net figure is its mark less what has *actually* been charged.
   * It deliberately does not guess the exit commission: a projected cost would
   * put a number on screen that no ledger entry will ever match.
   */
  it('nets a position against the costs already charged to it', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    expect(opened.positionId).not.toBeNull();

    await prisma.position.update({
      where: { id: opened.positionId as string },
      data: { commission: '7', swap: '-2.5' },
    });

    const valuation = await stack.accountState.valuate(accountId);
    const position = valuation.positions[0];
    expect(position).toBeDefined();
    expect(position?.commission.toString()).toBe('7.00');
    expect(position?.swap.toString()).toBe('-2.50');

    const expected = (Number(position?.floatingPnl.toString()) - 7 - 2.5).toFixed(2);
    expect(position?.netPnl.toString()).toBe(expected);
  });

  /**
   * The tick-driven frame deliberately omits realized P&L — nothing about it
   * changes on a tick, and the query would be paid on every valuation of every
   * watched account. Absent is not zero, and a client keeps its last value.
   */
  it('omits realized P&L from a valuation frame rather than sending a zero', async () => {
    const { userId, accountId, currency } = await createAccount(prisma, { balance: '100000' });
    await openAndClose(userId, accountId);

    const valuation = await stack.accountState.valuate(accountId);
    const frame = stack.accountState.toDto(valuation);
    expect('realizedPnlToday' in frame).toBe(false);

    const snapshot = stack.accountState.toDto(
      valuation,
      await stack.accountState.realized(accountId, currency),
    );
    expect(snapshot['realizedPnlToday']).not.toBeUndefined();
  });
});
