import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
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
 * The concurrency audit.
 *
 * `trading.test.ts` already covers the races this platform met while it was
 * being built: two closes of one position, ten closes, a modification losing to
 * a close, ten simultaneous opens. This file is the deliberate pass over the
 * races nobody had gone looking for yet, and it is written around one question:
 *
 * **which pair of simultaneous requests could create money?**
 *
 * Every case below is a pair that, if the locking were wrong, would leave the
 * account better off than the arithmetic allows: volume closed that was never
 * held, margin spent twice, one intention producing two positions, a position
 * closed by the engine and by its owner at the same instant and paid for both.
 *
 * Each ends by replaying the ledger. A race that leaves the right rows but the
 * wrong balance is the failure that matters, and it is the one a count of rows
 * cannot see.
 */
suite('Concurrency audit (integration)', () => {
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

  const openAccount = (balance = '100000') => createAccount(prisma, { balance });

  async function buy(userId: string, accountId: string, volume = '1.00'): Promise<string> {
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });
    if (opened.positionId === null) throw new Error('the market order opened no position');
    return opened.positionId;
  }

  /** The assertion every case ends with. */
  async function ledgerAgrees(accountId: string): Promise<void> {
    const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
    expect(replay.matches).toBe(true);
  }

  const settled = <T>(results: Array<PromiseSettledResult<T>>) => ({
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
  });

  describe('closing volume that was never held', () => {
    /**
     * Two partial closes that each fit and together do not.
     *
     * 0.6 + 0.6 against a 1.0 position. If both read the volume before either
     * wrote, both are valid, both are paid out, and the account has been paid
     * for 1.2 lots it never held. This is the shape of every double-spend.
     */
    it('refuses the second of two partial closes that together exceed the position', async () => {
      const { userId, accountId } = await openAccount();
      const positionId = await buy(userId, accountId);

      const results = await Promise.allSettled([
        stack.positions.close(userId, positionId, '0.6'),
        stack.positions.close(userId, positionId, '0.6'),
      ]);

      // Either may win; what may not happen is both.
      expect(settled(results).fulfilled).toBeLessThanOrEqual(1);

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      const closed = Number(
        (await prisma.trade.aggregate({ where: { positionId }, _sum: { volume: true } }))._sum
          .volume ?? 0,
      );
      expect(closed).toBeLessThanOrEqual(1);
      expect(Number(position.volume) + closed).toBeCloseTo(1, 8);

      await ledgerAgrees(accountId);
    });

    /**
     * Five partial closes at once, summing to two and a half times the position.
     *
     * The pairwise case can pass by luck — two requests can miss each other.
     * Five cannot all miss each other, and the total they would produce if the
     * lock failed is unmistakable.
     */
    it('never closes more than was held, whatever arrives at once', async () => {
      const { userId, accountId } = await openAccount();
      const positionId = await buy(userId, accountId);

      await Promise.allSettled(
        Array.from({ length: 5 }, () => stack.positions.close(userId, positionId, '0.5')),
      );

      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      const closed = Number(
        (await prisma.trade.aggregate({ where: { positionId }, _sum: { volume: true } }))._sum
          .volume ?? 0,
      );
      expect(closed).toBeLessThanOrEqual(1);
      expect(Number(position.volume) + closed).toBeCloseTo(1, 8);
      await ledgerAgrees(accountId);
    });
  });

  describe('spending the same margin twice', () => {
    /**
     * Two orders that each fit the free margin and together do not.
     *
     * If the margin check reads before either write commits, both pass and the
     * account is leveraged beyond what it can be — which the platform then
     * discovers as a stop-out on a position it should never have opened.
     */
    it('does not let two simultaneous orders share the same free margin', async () => {
      // Small enough that one lot fits and two do not.
      const { userId, accountId } = await openAccount('5000');

      const results = await Promise.allSettled([
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1.00',
        }),
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1.00',
        }),
      ]);

      const opened = await prisma.position.count({ where: { accountId } });
      const { state } = await stack.accountState.valuate(accountId);

      // Whatever got through, the account must not be holding more margin than
      // it has equity for. That — not the count — is the invariant: an account
      // whose used margin exceeds its equity has already been stopped out and
      // does not know it.
      expect(Number(state.usedMargin.toString())).toBeLessThanOrEqual(
        Number(state.equity.toString()),
      );
      expect(opened).toBe(settled(results).fulfilled);
      await ledgerAgrees(accountId);
    });
  });

  describe('the engine and the trader reaching for the same position', () => {
    /**
     * A stop-out firing while the owner closes by hand.
     *
     * The worst version pays the trade out twice: once to the engine's close and
     * once to the trader's. Both are legitimate instructions, they arrive in the
     * same millisecond, and only one may result in a trade.
     */
    it('pays for the close once when the engine and the trader both close it', async () => {
      const { userId, accountId } = await openAccount('5000');
      const positionId = await buy(userId, accountId, '1.00');

      // Far enough to put the account under the stop-out level.
      await stack.publishQuote('XAUUSD', '4000.00', '4000.14');

      await Promise.allSettled([
        stack.triggers.onTick({
          symbol: 'XAUUSD',
          bid: '4000.00',
          ask: '4000.14',
          timestamp: Date.now(),
          volume: '1',
        }),
        stack.positions.close(userId, positionId, null).catch(() => undefined),
      ]);

      // Exactly one, not "at most one": a run where neither path fired would
      // pass a `<= 1` assertion while proving nothing at all.
      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.status).toBe('CLOSED');
      expect(await prisma.trade.count({ where: { positionId } })).toBe(1);

      // One trade, one payment. Two payments for one close is the failure this
      // case exists for, and it is the reason the entry is counted rather than
      // the balance inspected: a double payment of a loss and a double payment
      // of a profit look different in the balance and identical here.
      expect(
        await prisma.balanceLedger.count({
          where: { accountId, type: { in: ['TRADE_PROFIT', 'TRADE_LOSS'] } },
        }),
      ).toBe(1);
      await ledgerAgrees(accountId);
    });
  });

  describe('a resting order cancelled as it triggers', () => {
    /**
     * A limit filling at the same moment its owner cancels it.
     *
     * Both outcomes are acceptable — the trader either gets the position or gets
     * their cancellation. What is not acceptable is both: a cancelled order that
     * also opened a position is an order the trader believes is gone and is
     * carrying risk from.
     */
    it('either fills or cancels, never both', async () => {
      const { userId, accountId } = await openAccount();
      const pending = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '0.5',
        price: '4500.00',
        timeInForce: 'GTC',
      });

      // A price that takes the limit out.
      await stack.publishQuote('XAUUSD', '4499.00', '4499.14');

      await Promise.allSettled([
        stack.triggers.onTick({
          symbol: 'XAUUSD',
          bid: '4499.00',
          ask: '4499.14',
          timestamp: Date.now(),
          volume: '1',
        }),
        stack.orders.cancelPending(userId, pending.orderId),
      ]);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: pending.orderId } });
      const positions = await prisma.position.count({ where: { accountId } });

      if (order.status === 'CANCELLED') {
        expect(positions).toBe(0);
      } else {
        expect(order.status).toBe('FILLED');
        expect(positions).toBe(1);
      }
      await ledgerAgrees(accountId);
    });
  });

  describe('the account row itself', () => {
    /**
     * Twenty trades at once against one account.
     *
     * `ledger.test.ts` proves two postings do not lose each other. This asks the
     * same question loudly enough that a lock held for slightly too short a
     * window would show, and it is here because the balance is the one number in
     * this system that cannot be recovered from anywhere else if it is wrong.
     */
    it('keeps the balance equal to its ledger under twenty simultaneous trades', async () => {
      const { userId, accountId } = await openAccount();

      const positions = await Promise.all(
        Array.from({ length: 20 }, () => buy(userId, accountId, '0.01')),
      );
      await Promise.all(positions.map((id) => stack.positions.close(userId, id, null)));

      expect(await prisma.trade.count({ where: { accountId } })).toBe(20);
      await ledgerAgrees(accountId);
    });
  });
});
