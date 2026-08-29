import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedJpySymbol,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Trading an instrument that is not quoted in the account's currency.
 *
 * Every other instrument this platform lists settles in USD, so
 * `ConversionService` and the `quoteToAccountRate` it produces — which
 * multiplies P&L, margin and exposure on every foreign-quoted position — were
 * reachable in production and exercised by nothing. USDJPY was seeded to make
 * that the ordinary case rather than the untested one.
 *
 * The second half of this file is the more important half: what happens when
 * the rate cannot be trusted. `midOf` now demands a *fresh* quote, and the
 * difference between refusing and quietly using an hour-old rate is the
 * difference between a rejected order and a P&L nobody can reconcile.
 */
suite('Foreign-quoted instruments (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;

  const JPY_BID = '155.240';
  const JPY_ASK = '155.260';

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
    await seedJpySymbol(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('USDJPY', JPY_BID, JPY_ASK);
  });

  it('opens a position in a JPY-quoted instrument on a USD account', async () => {
    const trader = await createAccount(prisma, { balance: '50000', currency: 'USD' });
    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'USDJPY',
      side: 'BUY',
      volume: '0.10',
    });
    expect(opened.positionId).not.toBeNull();
  });

  /**
   * The number that proves the conversion happened. 0.10 lots of a 100,000
   * contract is 10,000 units; a 0.200 move is 2,000 JPY, which at ~155 to the
   * dollar is roughly $13 — not $2,000, which is what an unconverted figure
   * would read.
   */
  it('reports P&L in the account currency, not the quote currency', async () => {
    const trader = await createAccount(prisma, { balance: '50000', currency: 'USD' });
    await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'USDJPY',
      side: 'BUY',
      volume: '0.10',
    });

    await stack.publishQuote('USDJPY', '155.440', '155.460');
    const valuation = await stack.accountState.valuate(trader.accountId);

    const pnl = Number(valuation.state.floatingPnl.toString());
    // The move is +0.200 on the bid against an entry at the ask.
    expect(pnl).toBeGreaterThan(10);
    expect(pnl).toBeLessThan(16);
  });

  it('holds margin in the account currency too', async () => {
    const trader = await createAccount(prisma, { balance: '50000', currency: 'USD' });
    await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'USDJPY',
      side: 'BUY',
      volume: '0.10',
    });

    const valuation = await stack.accountState.valuate(trader.accountId);
    const margin = Number(valuation.state.usedMargin.toString());

    /**
     * 0.10 lots of a 100,000 contract is 10,000 units. At the ask of 155.260
     * that is 1,552,600 JPY of notional; at 1:100 leverage the requirement is
     * 15,526 JPY, and at ~155.25 to the dollar that is about $100.
     *
     * The figure that would fail this test is 15,526 — the requirement left in
     * yen, which is what an unconverted margin looks like and which would let a
     * $50,000 account carry roughly 1/155th of the exposure it should.
     */
    expect(margin).toBeGreaterThan(95);
    expect(margin).toBeLessThan(105);
  });

  /**
   * The rule the freshness change exists for.
   *
   * A conversion rate is not a display figure: it multiplies P&L, margin and
   * exposure. An hour-old rate does not make those numbers slightly stale, it
   * makes them wrong by however far the currency has moved — and nothing on
   * screen or in the ledger would say so. Refusing is recoverable; pricing
   * against an unchecked rate is not.
   */
  it('refuses to convert through a rate that has gone stale', async () => {
    const rate = await stack.conversion.rate('JPY', 'USD');
    expect(toDecimal(rate.toString()).gt(0)).toBe(true);

    // The feed for USDJPY stops. Nothing else changes.
    await stack.publishQuote('USDJPY', JPY_BID, JPY_ASK, Date.now() - 3_600_000);

    await expect(stack.conversion.rate('JPY', 'USD')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('inverts the pair it has rather than demanding one quoted the other way', async () => {
    // There is no JPYUSD instrument; the rate must come from 1 / USDJPY.
    const rate = Number((await stack.conversion.rate('JPY', 'USD')).toString());
    expect(rate).toBeCloseTo(1 / 155.25, 6);
  });

  it('is exactly one when nothing needs converting', async () => {
    const rate = await stack.conversion.rate('USD', 'USD');
    expect(rate.toString()).toBe('1');
  });
});
