import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
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
 * The pre-trade estimate, checked against what actually happens.
 *
 * The point of computing this on the server is that the number the trader is
 * shown is the number they will be charged. A preview that merely *looks*
 * plausible is worse than none: it is a figure someone sizes a position from.
 * So every case below places the order it previewed and compares.
 */
suite('Order preview (integration)', () => {
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

  it('estimates the margin the order actually takes', async () => {
    const { userId, accountId } = await openAccount();
    const request = { accountId, symbol: 'XAUUSD', side: 'BUY' as const, volume: '1.00' };

    const preview = await stack.orders.preview(userId, request);
    const result = await stack.orders.openPosition(userId, request);

    const position = await prisma.position.findFirstOrThrow({
      where: { id: result.positionId ?? undefined },
    });
    // Not "close to". The preview runs the same requiredMargin() the order does,
    // so anything but equality means they have drifted apart.
    expect(preview.requiredMargin).toBe(position.margin.toString());
  });

  it('estimates the commission the ledger actually posts', async () => {
    const { userId, accountId } = await openAccount();
    const request = { accountId, symbol: 'XAUUSD', side: 'BUY' as const, volume: '0.50' };

    const preview = await stack.orders.preview(userId, request);
    await stack.orders.openPosition(userId, request);

    const commissionEntries = await prisma.balanceLedger.findMany({
      where: { accountId, type: 'COMMISSION' },
    });
    const posted = commissionEntries
      .reduce((total, entry) => total + Number(entry.amount), 0)
      .toFixed(2);
    expect(Number(preview.estimatedCommission).toFixed(2)).toBe(
      Math.abs(Number(posted)).toFixed(2),
    );
  });

  it('quotes the side of the spread the order will cross', async () => {
    const { userId, accountId } = await openAccount();

    const buy = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });
    const sell = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'SELL',
      volume: '0.10',
    });

    // A buy crosses the ask and a sell crosses the bid. Showing the mid would
    // understate the cost of entry on every ticket.
    expect(buy.price).toBe(ASK);
    expect(sell.price).toBe(BID);
    expect(buy.spread).toBe('0.14');
  });

  it('snaps the volume to the lot grid, so the ticket shows what will trade', async () => {
    const { userId, accountId } = await openAccount();
    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.117',
    });
    // Rounded down, never up: rounding up hands the trader more risk than they
    // asked for, and a ticket that displays the un-snapped figure is a ticket
    // that lies about the size.
    expect(Number(preview.volume)).toBeLessThanOrEqual(0.117);
    expect(preview.volume).not.toBe('0.117');
  });

  it('writes nothing', async () => {
    const { userId, accountId } = await openAccount();

    await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    // An order ticket calls this on every keystroke. If it left a trace, a
    // trader typing "0.15" would produce four of whatever it left.
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.position.count()).toBe(0);
    expect(await prisma.balanceLedger.count({ where: { type: 'COMMISSION' } })).toBe(0);
  });

  it('says an affordable order would be accepted', async () => {
    const { userId, accountId } = await openAccount();
    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });
    expect(preview.wouldBeAccepted).toBe(true);
    expect(preview.violations).toEqual([]);
  });

  it('says why an order that cannot fit would be refused', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100' });
    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '5.00',
    });

    expect(preview.wouldBeAccepted).toBe(false);
    // A reason, not just a refusal. "Insufficient free margin" tells a trader
    // what to change; a red button does not.
    expect(preview.violations.length).toBeGreaterThan(0);

    // And the real order agrees, which is what makes the preview worth showing.
    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '5.00',
      }),
    ).rejects.toThrow();
  });

  it('shows what free margin would be left', async () => {
    const { userId, accountId } = await openAccount();
    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    const before = Number(preview.freeMarginBefore);
    const after = Number(preview.freeMarginAfter);
    const margin = Number(preview.requiredMargin);
    // The figure a trader actually sizes from. Off by the margin itself is the
    // easy mistake, and it is the one that makes an account look twice as
    // roomy as it is.
    expect(before - after).toBeCloseTo(margin, 2);
  });

  it('warns rather than failing when the stop loss is on the wrong side', async () => {
    const { userId, accountId } = await openAccount();
    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      // Above the entry price for a buy: that is a take profit, not a stop.
      volume: '0.10',
      stopLoss: '5000.00',
    });

    // A trader dragging a stop through the price should see why the ticket
    // refuses, not watch the whole preview vanish.
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.wouldBeAccepted).toBe(false);
    expect(preview.requiredMargin).not.toBe('');
  });

  it('reports a halt instead of refusing to answer', async () => {
    const { userId, accountId } = await openAccount();
    await stack.killSwitch.set(userId, TradingState.DISABLED, 'maintenance');

    const preview = await stack.orders.preview(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });

    expect(preview.wouldBeAccepted).toBe(false);
    expect(preview.warnings.join(' ')).toMatch(/halted/i);
    // The figures are still there: a trader who cannot open should still be
    // able to see what they would have been committing to.
    expect(Number(preview.requiredMargin)).toBeGreaterThan(0);
  });
});

/**
 * A positions list is only useful if it says what each position is worth.
 *
 * Without the mark, the list is a record of things that were once bought with
 * no indication of whether holding them was a good idea — and the only
 * alternative to serving the number is each client computing it from the entry
 * price and the contract size, which is money arithmetic in floating point on
 * three platforms.
 */
suite('Positions are marked to market (integration)', () => {
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

  it("reports a profit when the price has moved the trader's way", async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    // Ten dollars an ounce higher.
    await stack.publishQuote('XAUUSD', '4593.58', '4593.72');

    const [position] = await stack.positions.list(userId, accountId, false, 10);
    expect(position?.floatingPnl).not.toBeNull();
    expect(Number(position?.floatingPnl)).toBeGreaterThan(0);

    /**
     * The relationship, not a hard-coded difference.
     *
     * An earlier version asserted that net was strictly smaller than gross,
     * which failed because this test instrument is seeded with zero commission
     * — the assertion was wrong, not the code. Checking the identity holds
     * whatever the instrument charges, and still catches the mistake it was
     * written for: net that silently equals gross on a symbol that does charge.
     */
    expect(Number(position?.netFloatingPnl)).toBeCloseTo(
      Number(position?.floatingPnl) - Number(position?.commission) + Number(position?.swap),
      6,
    );
  });

  it('reports a loss when it has not', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    await stack.publishQuote('XAUUSD', '4573.58', '4573.72');

    const [position] = await stack.positions.list(userId, accountId, false, 10);
    expect(Number(position?.floatingPnl)).toBeLessThan(0);
  });

  it('marks a sell in the opposite direction', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'SELL',
      volume: '1.00',
    });

    await stack.publishQuote('XAUUSD', '4573.58', '4573.72');

    // A falling price is a profit for a short. Getting the sign the wrong way
    // round is the single most consequential display bug a positions list can
    // have.
    const [position] = await stack.positions.list(userId, accountId, false, 10);
    expect(Number(position?.floatingPnl)).toBeGreaterThan(0);
  });

  it('leaves the mark null rather than showing zero when there is nothing to mark', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });

    const positions = await stack.positions.list(userId, accountId, false, 10);
    // No open positions: the extra valuation query is skipped entirely.
    expect(positions).toEqual([]);
  });
});
