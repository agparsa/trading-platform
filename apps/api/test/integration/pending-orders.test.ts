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
 * Resting orders.
 *
 * A LIMIT or STOP order is a promise the platform makes while nobody is
 * watching: the trader closes the terminal expecting it to fire at a price, and
 * nothing about that is verifiable by looking at a screen. Every path here is
 * therefore driven end to end — placed, tripped by a real tick, and read back
 * from the database and the ledger.
 */
suite('Resting orders (integration)', () => {
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

  /** Publish a price and let the engine act on it, as the live feed would. */
  const moveTo = async (bid: string, ask: string) => {
    await stack.publishQuote('XAUUSD', bid, ask);
    await stack.triggers.onTick({
      symbol: 'XAUUSD',
      bid,
      ask,
      timestamp: Date.now(),
      volume: '1',
    });
  };

  const placeBuyLimit = async (userId: string, accountId: string, price = '4550.00') =>
    stack.orders.placePending(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '1.00',
      price,
    });

  describe('placement', () => {
    it('rests without opening a position or consuming margin', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId);

      expect(order.status).toBe('PENDING');
      expect(order.price).toBe('4550');

      const positions = await prisma.position.findMany({ where: { accountId } });
      expect(positions).toHaveLength(0);

      // Nothing is reserved: a resting order should not tie up buying power it
      // may never use.
      const state = await stack.accountState.valuate(accountId);
      expect(state.state.usedMargin.toString()).toBe('0.00');
      expect(state.state.freeMargin.toString()).toBe('100000.00');
    });

    it('records the accepted lifecycle in the event trail', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId);
      const events = await prisma.orderEvent.findMany({
        where: { orderId: order.orderId },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED']);
      expect(events[1]?.toStatus).toBe('PENDING');
    });

    /**
     * The rule that matters most. An order placed on the wrong side of the
     * market is not a resting order — it fires on the very next tick, and the
     * trader gets a market order at a price they never chose.
     */
    it('refuses each of the four orders placed on the wrong side', async () => {
      const { userId, accountId } = await openAccount();
      const place = (type: 'LIMIT' | 'STOP', side: 'BUY' | 'SELL', price: string) =>
        stack.orders.placePending(userId, {
          accountId,
          symbol: 'XAUUSD',
          side,
          type,
          volume: '1.00',
          price,
        });

      await expect(place('LIMIT', 'BUY', '4600.00')).rejects.toMatchObject({
        code: 'INVALID_PRICE',
      });
      await expect(place('LIMIT', 'SELL', '4500.00')).rejects.toMatchObject({
        code: 'INVALID_PRICE',
      });
      await expect(place('STOP', 'BUY', '4500.00')).rejects.toMatchObject({
        code: 'INVALID_PRICE',
      });
      await expect(place('STOP', 'SELL', '4600.00')).rejects.toMatchObject({
        code: 'INVALID_PRICE',
      });
    });

    it('validates protective levels against the resting price, not the market', async () => {
      const { userId, accountId } = await openAccount();
      // A stop-loss at 4570 is below today's market but *above* a limit resting
      // at 4550 — nonsense for the order it is meant to protect.
      await expect(
        stack.orders.placePending(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'LIMIT',
          volume: '1.00',
          price: '4550.00',
          stopLoss: '4570.00',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STOP_LOSS' });
    });

    it('rejects a price off the tick grid', async () => {
      const { userId, accountId } = await openAccount();
      await expect(placeBuyLimit(userId, accountId, '4550.005')).rejects.toMatchObject({
        code: 'INVALID_PRICE',
      });
    });

    it('refuses to rest an order on a suspended account', async () => {
      const { userId, accountId } = await openAccount();
      await prisma.account.update({ where: { id: accountId }, data: { status: 'SUSPENDED' } });
      await expect(placeBuyLimit(userId, accountId)).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_TRADEABLE',
      });
    });
  });

  describe('firing', () => {
    it('fills a buy limit when the ask falls to it, and opens the position', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');

      await moveTo('4560.00', '4560.14');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe(
        'PENDING',
      );

      await moveTo('4549.86', '4550.00');

      const filled = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(filled.status).toBe('FILLED');
      expect(filled.filledVolume.toString()).toBe('1');

      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.status).toBe('OPEN');
      // A buy opens at the ask, which is where the limit was reached.
      expect(position.entryPrice.toString()).toBe('4550');
      expect(filled.positionId).toBe(position.id);
    });

    it('fills a sell stop when the bid falls to it', async () => {
      const { userId, accountId } = await openAccount();
      const order = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'SELL',
        type: 'STOP',
        volume: '1.00',
        price: '4500.00',
      });

      await moveTo('4500.00', '4500.14');

      const filled = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(filled.status).toBe('FILLED');
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.side).toBe('SELL');
      // A sell opens at the bid.
      expect(position.entryPrice.toString()).toBe('4500');
    });

    it('fills a buy stop when the ask rises to it', async () => {
      const { userId, accountId } = await openAccount();
      await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'STOP',
        volume: '1.00',
        price: '4600.00',
      });

      await moveTo('4599.86', '4600.00');
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.side).toBe('BUY');
      expect(position.entryPrice.toString()).toBe('4600');
    });

    it('carries the order’s protective levels onto the position', async () => {
      const { userId, accountId } = await openAccount();
      await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
        stopLoss: '4500.00',
        takeProfit: '4650.00',
      });

      await moveTo('4549.86', '4550.00');
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.stopLoss?.toString()).toBe('4500');
      expect(position.takeProfit?.toString()).toBe('4650');
    });

    /**
     * A stop fills at the market once triggered, not at its resting price, and
     * the difference is real money. Recording both means a trader disputing a
     * fill can see exactly what happened rather than being told a number.
     */
    it('records the slippage when a gap fills a stop worse than it rested', async () => {
      const { userId, accountId } = await openAccount();
      const order = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'STOP',
        volume: '1.00',
        price: '4600.00',
      });

      // The market gaps straight through the stop.
      await moveTo('4619.86', '4620.00');

      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4620');

      const fill = await prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.orderId, type: 'FILLED' },
      });
      const payload = fill.payload as Record<string, string>;
      expect(payload['restingPrice']).toBe('4600');
      expect(payload['price']).toBe('4620');
      expect(payload['slippage']).toBe('20');
    });

    it('charges commission and posts it to the ledger, as a market order does', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { commissionPerLot: '7' },
      });
      await stack.symbols.reload();
      stack = await buildTradingStack(prisma);
      await stack.publishQuote('XAUUSD', BID, ASK);

      const { userId, accountId } = await openAccount();
      await placeBuyLimit(userId, accountId, '4550.00');
      await moveTo('4549.86', '4550.00');

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'COMMISSION' },
      });
      expect(entry.amount.toString()).toBe('-7');

      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });
  });

  describe('risk at the moment of firing', () => {
    /**
     * Nothing is reserved when a resting order is placed, so by the time it
     * fires the account may not be able to carry it. The order must be rejected
     * loudly — not filled into a margin call, and not silently dropped.
     *
     * The order is oversized rather than the account being drained by another
     * position, so this tests one thing: the risk decision at the moment of
     * firing, with no stop-out of an unrelated position confusing the result.
     */
    const placeUnaffordable = async (userId: string, accountId: string) =>
      stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        // 40 lots at 4550 is 18.2m notional; 1% margin is 182,000 against a
        // 100,000 account.
        volume: '40.00',
        price: '4550.00',
      });

    it('rejects a resting order the account cannot carry', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeUnaffordable(userId, accountId);

      await moveTo('4549.86', '4550.00');

      const rejected = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejectionCode).toBe('INSUFFICIENT_MARGIN');
      expect(rejected.positionId).toBeNull();
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);

      const event = await prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.orderId, type: 'REJECTED' },
      });
      expect(event.toStatus).toBe('REJECTED');
    });

    /** A rejected fill must cost nothing — not even the commission it would have charged. */
    it('posts nothing to the ledger when a firing order is rejected', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { commissionPerLot: '7' },
      });
      await stack.symbols.reload();
      stack = await buildTradingStack(prisma);
      await stack.publishQuote('XAUUSD', BID, ASK);

      const { userId, accountId } = await openAccount();
      await placeUnaffordable(userId, accountId);
      // Only the opening deposit.
      const before = await prisma.balanceLedger.count({ where: { accountId } });
      expect(before).toBe(1);

      await moveTo('4549.86', '4550.00');

      expect(await prisma.balanceLedger.count({ where: { accountId } })).toBe(before);
      const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
      expect(replay.matches).toBe(true);
    });

    it('records why, so the trader can see what the engine decided', async () => {
      const { userId, accountId } = await openAccount();
      await placeUnaffordable(userId, accountId);
      await moveTo('4549.86', '4550.00');

      const risk = await prisma.riskEvent.findFirstOrThrow({ where: { accountId } });
      expect(risk.code).toBe('INSUFFICIENT_MARGIN');
      expect(risk.severity).toBe('REJECTED');
    });
  });

  describe('expiry', () => {
    it('lets a GTD order lapse instead of filling it', async () => {
      const { userId, accountId } = await openAccount();
      const order = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
        timeInForce: 'GTD',
        expiresAt: Date.now() + 60_000,
      });

      // Move the expiry into the past, as the clock would.
      await prisma.order.update({
        where: { id: order.orderId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      // A tick that would otherwise fill it.
      await moveTo('4549.86', '4550.00');

      const expired = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(expired.status).toBe('EXPIRED');
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);
    });

    it('refuses a GTD order with no expiry, rather than treating it as GTC', async () => {
      const { userId, accountId } = await openAccount();
      await expect(
        stack.orders.placePending(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'LIMIT',
          volume: '1.00',
          price: '4550.00',
          timeInForce: 'GTD',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('gives a DAY order an expiry without being told one', async () => {
      const { userId, accountId } = await openAccount();
      const order = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
        timeInForce: 'DAY',
      });
      expect(order.expiresAt).not.toBeNull();
      expect(new Date(order.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('cancel and modify', () => {
    it('cancels a resting order', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId);

      const cancelled = await stack.orders.cancelPending(userId, order.orderId);
      expect(cancelled.status).toBe('CANCELLED');

      // And it no longer fires.
      await moveTo('4549.86', '4550.00');
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);
    });

    it('will not cancel an order that has already filled', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');
      await moveTo('4549.86', '4550.00');

      await expect(stack.orders.cancelPending(userId, order.orderId)).rejects.toMatchObject({
        code: 'ORDER_NOT_MODIFIABLE',
      });
    });

    it('moves a resting price and fires at the new one', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');

      await stack.orders.modifyPending(userId, { orderId: order.orderId, price: '4500.00' });

      // The old price no longer fills it.
      await moveTo('4549.86', '4550.00');
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);

      await moveTo('4499.86', '4500.00');
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4500');
    });

    it('re-validates protective levels against the new price', async () => {
      const { userId, accountId } = await openAccount();
      const order = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
        stopLoss: '4500.00',
      });

      // Moving the limit *below* its own stop-loss must fail, not silently
      // leave a stop that would fire the instant the order filled.
      await expect(
        stack.orders.modifyPending(userId, { orderId: order.orderId, price: '4490.00' }),
      ).rejects.toMatchObject({ code: 'INVALID_STOP_LOSS' });
    });

    it('records the previous values so the change is reconstructable', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');
      await stack.orders.modifyPending(userId, { orderId: order.orderId, price: '4500.00' });

      const event = await prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.orderId, type: 'MODIFIED' },
      });
      const payload = event.payload as Record<string, string>;
      expect(payload['previousPrice']).toBe('4550');
      expect(payload['price']).toBe('4500.00');
    });

    it('will not let one user touch another user’s order', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId);
      const other = await openAccount();

      await expect(stack.orders.cancelPending(other.userId, order.orderId)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('concurrency', () => {
    /**
     * Two ticks arriving close together must not both open a position from one
     * order. The claim is a single conditional update, so exactly one pass can
     * win.
     */
    it('opens one position when two ticks trip the same order at once', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');
      await stack.publishQuote('XAUUSD', '4549.86', '4550.00');

      const tick = {
        symbol: 'XAUUSD',
        bid: '4549.86',
        ask: '4550.00',
        timestamp: Date.now(),
        volume: '1',
      };
      const results = await Promise.allSettled([
        stack.orders.fillPending(order.orderId, tick),
        stack.orders.fillPending(order.orderId, tick),
      ]);

      const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value : 'threw'));
      expect(outcomes.filter((o) => o === 'filled')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'lost')).toHaveLength(1);
      expect(await prisma.position.count({ where: { accountId } })).toBe(1);
    });

    it('reports a cancel that lost to a fill rather than undoing the position', async () => {
      const { userId, accountId } = await openAccount();
      const order = await placeBuyLimit(userId, accountId, '4550.00');
      await stack.publishQuote('XAUUSD', '4549.86', '4550.00');
      const tick = {
        symbol: 'XAUUSD',
        bid: '4549.86',
        ask: '4550.00',
        timestamp: Date.now(),
        volume: '1',
      };

      const [fill, cancel] = await Promise.allSettled([
        stack.orders.fillPending(order.orderId, tick),
        stack.orders.cancelPending(userId, order.orderId),
      ]);

      // Whichever won, the outcome is consistent: a filled order keeps its
      // position, a cancelled one never made one.
      const filled = fill.status === 'fulfilled' && fill.value === 'filled';
      const positions = await prisma.position.count({ where: { accountId } });
      expect(positions).toBe(filled ? 1 : 0);
      if (filled) expect(cancel.status).toBe('rejected');

      const finalState = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(['FILLED', 'CANCELLED']).toContain(finalState.status);
    });
  });

  describe('listing', () => {
    it('lists only what is still resting', async () => {
      const { userId, accountId } = await openAccount();
      const resting = await placeBuyLimit(userId, accountId, '4550.00');
      const doomed = await placeBuyLimit(userId, accountId, '4540.00');
      await stack.orders.cancelPending(userId, doomed.orderId);

      const list = await stack.orders.listPending(userId, accountId);
      expect(list.map((o) => o.orderId)).toEqual([resting.orderId]);
      expect(Money.of(list[0]!.volume, 'USD').toString()).toBe('1.00');
    });
  });
});
