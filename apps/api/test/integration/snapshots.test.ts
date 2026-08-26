import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
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
 * Account snapshots.
 *
 * They exist so that "what was this account worth at 14:00" has an answer that
 * does not require replaying the tick stream. The two things worth proving are
 * that the numbers match the live valuation exactly — a snapshot disagreeing
 * with the stop-out that closed a position is unresolvable — and that a pass
 * costs work proportional to activity rather than to registrations.
 */
suite('Account snapshots (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;

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

  it('records exactly what the live valuation says', async () => {
    const { userId, accountId } = await openAccount();
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');

    const live = await stack.accountState.valuate(accountId);
    await stack.snapshots.run();

    // Compared as money, not as raw column text: PostgreSQL drops trailing zeros
    // on the way back, and '101628' and '101628.00' are the same amount.
    const money = (value: { toString(): string }) => Money.of(value.toString(), 'USD').toString();

    const snapshot = await prisma.accountSnapshot.findFirstOrThrow({ where: { accountId } });
    expect(money(snapshot.equity)).toBe(live.state.equity.toString());
    expect(money(snapshot.balance)).toBe(live.state.balance.toString());
    expect(money(snapshot.usedMargin)).toBe(live.state.usedMargin.toString());
    expect(money(snapshot.freeMargin)).toBe(live.state.freeMargin.toString());
    expect(money(snapshot.floatingPnl)).toBe(live.state.floatingPnl.toString());
    expect(snapshot.openPositions).toBe(1);
  });

  /** Null, not zero and not infinity — the ratio is undefined without margin. */
  it('leaves the margin level null when nothing is committed', async () => {
    const { accountId } = await openAccount();
    await stack.snapshots.run();
    const snapshot = await prisma.accountSnapshot.findFirstOrThrow({ where: { accountId } });
    expect(snapshot.marginLevel).toBeNull();
    expect(snapshot.openPositions).toBe(0);
  });

  it('snapshots an account whose balance moved but holds no position', async () => {
    // The opening deposit is a ledger movement, so a new account qualifies.
    const { accountId } = await openAccount();
    const result = await stack.snapshots.run();
    expect(result.taken).toBe(1);
    expect(await prisma.accountSnapshot.count({ where: { accountId } })).toBe(1);
  });

  /**
   * Cost scales with activity, not with registrations. A dormant account's
   * equity is its balance, and its last snapshot already says so.
   */
  it('skips an account with nothing new to record', async () => {
    await openAccount();
    // Taken *after* the opening deposit, so the deposit is no longer newer than
    // the account's last snapshot.
    await stack.snapshots.run(new Date());

    const second = await stack.snapshots.run();
    expect(second.taken).toBe(0);
  });

  it('keeps snapshotting an account that still holds a position', async () => {
    const { userId, accountId } = await openAccount();
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    await stack.snapshots.run(new Date(Date.now() - 1_000));

    // The market moved, so its equity is different even though nothing was traded.
    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
    const second = await stack.snapshots.run();
    expect(second.taken).toBe(1);
    expect(await prisma.accountSnapshot.count({ where: { accountId } })).toBe(2);
  });

  /** A retry after a partial pass must correct the row, not duplicate the instant. */
  it('is idempotent for one instant', async () => {
    const { accountId } = await openAccount();
    const at = new Date();
    await stack.snapshots.run(at);
    await stack.snapshots.run(at);
    expect(await prisma.accountSnapshot.count({ where: { accountId } })).toBe(1);
  });

  it('builds a history in time order', async () => {
    const { userId, accountId } = await openAccount();
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    await stack.snapshots.run(new Date(Date.now() - 2_000));
    await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
    await stack.snapshots.run(new Date(Date.now() - 1_000));

    const rows = await prisma.accountSnapshot.findMany({
      where: { accountId },
      orderBy: { takenAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(Number(rows[1]!.equity)).toBeGreaterThan(Number(rows[0]!.equity));
  });

  /**
   * One account that cannot be valued must not cost every other account its
   * snapshot — a feed outage on one instrument would otherwise blank the history
   * for the whole platform.
   */
  it('records the accounts it can when one cannot be valued', async () => {
    const healthy = await openAccount();
    const holder = await openAccount();
    await stack.orders.openPosition(holder.userId, {
      accountId: holder.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    // Age the quote past the freshness limit, so valuing the open position
    // fails the way a feed outage would.
    await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 600_000);

    const result = await stack.snapshots.run();
    expect(result.taken + result.skipped).toBeGreaterThanOrEqual(2);
    // The account with no position is unaffected by the stale instrument.
    expect(await prisma.accountSnapshot.count({ where: { accountId: healthy.accountId } })).toBe(1);
  });
});
