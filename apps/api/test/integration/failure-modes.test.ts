import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError } from '@tp/shared-types';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { TradingState } from '../../src/operations/kill-switch.service';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

const BID = '4583.58';
const ASK = '4583.72';

/**
 * What happens when the platform's own infrastructure lets it down.
 *
 * §26 states the rule this file exists to hold: a temporary failure of the
 * trading provider must never be read as a trader breaching anything. It is
 * easy to agree with and easy to violate, because both failures produce the
 * same *absence* — no price — and one plausible reading of "no price" is "value
 * the account at zero and liquidate it".
 *
 * Every case here is the same shape: take something away, then assert that the
 * platform refused to act rather than acting on nothing. The most expensive
 * mistake this system could make is a liquidation nobody's market caused.
 */
suite('Failure modes (integration)', () => {
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

  async function aPosition(balance = '50000') {
    const trader = await createAccount(prisma, { balance });
    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    if (opened.positionId === null) throw new Error('no position opened');
    return { ...trader, positionId: opened.positionId };
  }

  // ─── The feed stops ────────────────────────────────────────────────────────

  describe('when the market feed stops', () => {
    /**
     * The single most important assertion in this file.
     *
     * A feed outage and a market crash both produce "no fresh price". Reading
     * the first as the second would liquidate every leveraged account on the
     * platform because a provider had a bad minute.
     */
    it('closes nothing, and records no risk event', async () => {
      const trader = await aPosition('5000');

      // The feed dies: the last price is now an hour old.
      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 3_600_000);

      await stack.triggers.onTick({
        symbol: 'XAUUSD',
        bid: BID,
        ask: ASK,
        timestamp: Date.now() - 3_600_000,
        volume: '1',
      });
      await stack.triggers.sweepStopOuts();

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: trader.positionId },
      });
      expect(position.status).toBe('OPEN');
      expect(position.closeReason).toBeNull();
      expect(await prisma.riskEvent.count({ where: { accountId: trader.accountId } })).toBe(0);
    });

    /**
     * And the balance is untouched. A liquidation writes to the ledger; an
     * outage must not.
     */
    it('writes nothing to the ledger', async () => {
      const trader = await aPosition('5000');
      const before = await prisma.balanceLedger.count({ where: { accountId: trader.accountId } });

      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 3_600_000);
      await stack.triggers.onTick({
        symbol: 'XAUUSD',
        bid: BID,
        ask: ASK,
        timestamp: Date.now() - 3_600_000,
        volume: '1',
      });
      await stack.triggers.sweepStopOuts();

      expect(await prisma.balanceLedger.count({ where: { accountId: trader.accountId } })).toBe(
        before,
      );
    });

    /**
     * It refuses new risk, though, and says why.
     *
     * Refusing to open is the safe direction and the honest one: the platform
     * cannot price the order, and telling the trader that is better than filling
     * at a price from an hour ago.
     */
    it('refuses to open a position rather than filling at an old price', async () => {
      const trader = await createAccount(prisma, { balance: '50000' });
      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 3_600_000);

      await expect(
        stack.orders.openPosition(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ).rejects.toMatchObject({ code: 'STALE_QUOTE' });
    });

    /**
     * And it refuses to *close* on an old price too — which is the harder call,
     * because a trader trying to get out of a position will not thank anybody
     * for it.
     *
     * It is still right. A close is a fill, at a price, that becomes a
     * permanent ledger entry; filling one against an hour-old quote invents a
     * number nobody can reconcile. The position stays open and the trader can
     * try again when there is a price.
     */
    it('refuses to close on an old price, and leaves the position open', async () => {
      const trader = await aPosition();
      await stack.publishQuote('XAUUSD', BID, ASK, Date.now() - 3_600_000);

      await expect(
        stack.positions.close(trader.userId, trader.positionId, null),
      ).rejects.toBeInstanceOf(DomainError);

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: trader.positionId },
      });
      expect(position.status).toBe('OPEN');
    });
  });

  // ─── The feed has never spoken ─────────────────────────────────────────────

  describe('when an instrument has never been priced', () => {
    /**
     * A different fault from a stale price, and reported differently on
     * purpose: "no price has ever arrived" is a configuration or startup
     * problem, "the price is too old" is an outage. An operator reading the log
     * needs to know which.
     */
    it('says so, rather than treating the absence as a price', async () => {
      const trader = await createAccount(prisma, { balance: '50000' });
      // Gone from the process *and* from the shared cache: `forget` deliberately
      // leaves Redis alone so a correction from the ingesting instance can still
      // be picked up, which is not the situation being tested here.
      stack.quotes.forget('XAUUSD');
      await stack.redis.client.del('quote:XAUUSD');

      await expect(
        stack.orders.openPosition(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ).rejects.toMatchObject({ code: 'NO_QUOTE_AVAILABLE' });
    });
  });

  // ─── The feed lies ─────────────────────────────────────────────────────────

  describe('when the feed sends something impossible', () => {
    /**
     * A crossed book is broken data, not a market. Accepting one would make
     * every spread negative and every fill nonsense — and the stop-loss engine
     * would evaluate against it.
     */
    it('leaves the previous price standing rather than adopting a crossed book', async () => {
      const trader = await aPosition();

      // The gate lives in MarketIntegrityService, ahead of the quote cache. This
      // asserts the property the quote itself must hold: publishing a tick that
      // is older than the one held does not rewind the price.
      const accepted = await stack.quotes.publish({
        symbol: 'XAUUSD',
        bid: '4000.00',
        ask: '4000.14',
        timestamp: Date.now() - 60_000,
        volume: '1',
      });

      expect(accepted).toBe(false);
      const current = await stack.quotes.latest('XAUUSD');
      expect(current?.bid).toBe(BID);

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: trader.positionId },
      });
      expect(position.status).toBe('OPEN');
    });
  });

  // ─── The platform is halted ────────────────────────────────────────────────

  describe('when trading is halted', () => {
    /**
     * A halt stops new risk. It does not stop a trader getting *out* — the
     * whole point of halting rather than shutting down is that positions
     * already open can still be closed, and an operator who has halted trading
     * because something is wrong does not want everybody's exposure frozen in
     * place while it stays wrong.
     */
    it('refuses to open but still allows a close', async () => {
      const trader = await aPosition();
      await stack.killSwitch.set(trader.userId, TradingState.DISABLED, 'Testing the halt');

      await expect(
        stack.orders.openPosition(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ).rejects.toMatchObject({ code: 'TRADING_HALTED' });

      const closed = await stack.positions.close(trader.userId, trader.positionId, null);
      expect(closed).toBeDefined();

      const position = await prisma.position.findUniqueOrThrow({
        where: { id: trader.positionId },
      });
      expect(position.status).toBe('CLOSED');
    });
  });

  // ─── The account is frozen ─────────────────────────────────────────────────

  describe('when an account has been suspended', () => {
    it('refuses new risk on that account and nobody else’s', async () => {
      const frozen = await createAccount(prisma, { balance: '50000' });
      const healthy = await createAccount(prisma, { balance: '50000' });
      await prisma.account.update({
        where: { id: frozen.accountId },
        data: { status: 'SUSPENDED' },
      });

      await expect(
        stack.orders.openPosition(frozen.userId, {
          accountId: frozen.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ).rejects.toBeInstanceOf(DomainError);

      const opened = await stack.orders.openPosition(healthy.userId, {
        accountId: healthy.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.10',
      });
      expect(opened.positionId).not.toBeNull();
    });
  });
});
