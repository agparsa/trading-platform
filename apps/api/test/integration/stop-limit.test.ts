import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Feature, OrderStatus, TradingErrorCode } from '@tp/shared-types';
import { canTransitionOrder } from '@tp/trading-core';
import { withTenant } from '@tp/tenancy';
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
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

/**
 * Stop-limit orders.
 *
 * Two prices, two phases. Until its stop is reached the order waits as a stop;
 * once reached it is *activated* and rests as a limit at its limit price, and
 * from then on it fills at that price or better or not at all. It never
 * becomes a market order — that is the whole difference from a stop, and the
 * thing these tests pin from every side: a gap through the limit, a burst that
 * touched both prices and came back, a limit placed below the stop that waits
 * for the pull-back, and a modification racing the activation.
 */
suite('Stop-limit orders (integration)', () => {
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

  const moveTo = async (bid: string, ask: string) => {
    await stack.publishQuote('XAUUSD', bid, ask);
    await stack.triggers.onTick({ symbol: 'XAUUSD', bid, ask, timestamp: Date.now(), volume: '1' });
  };

  /** Several ticks in one window: detection on the extremes, execution on the last. */
  const burst = async (prices: ReadonlyArray<[string, string]>) => {
    const last = prices[prices.length - 1]!;
    await stack.publishQuote('XAUUSD', last[0], last[1]);
    const at = Date.now();
    await Promise.all(
      prices.map(([bid, ask], index) =>
        stack.triggers.onTick({ symbol: 'XAUUSD', bid, ask, timestamp: at + index, volume: '1' }),
      ),
    );
  };

  const place = (
    userId: string,
    accountId: string,
    side: 'BUY' | 'SELL',
    stopPrice: string,
    price: string,
  ) =>
    stack.orders.placePending(userId, {
      accountId,
      symbol: 'XAUUSD',
      side,
      type: 'STOP_LIMIT',
      volume: '1.00',
      price,
      stopPrice,
    });

  const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const eventsOf = (orderId: string) =>
    prisma.orderEvent.findMany({ where: { orderId }, orderBy: { seq: 'asc' } });

  describe('placement', () => {
    it('rests with both prices, waiting for its stop', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      expect(placed).toMatchObject({
        status: OrderStatus.PENDING,
        type: 'STOP_LIMIT',
        price: '4602',
        stopPrice: '4600',
        activatedAt: null,
      });
      const row = await orderOf(placed.orderId);
      expect(row.stopPrice?.toString()).toBe('4600');
      expect(row.price?.toString()).toBe('4602');
      expect(row.activatedAt).toBeNull();
      const listed = await stack.orders.listPending(userId, accountId);
      expect(listed[0]).toMatchObject({ stopPrice: '4600', activatedAt: null });
    });

    it('refuses a stop the market has already reached', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      await expect(place(userId, accountId, 'BUY', '4580.00', '4590.00')).rejects.toMatchObject({
        code: TradingErrorCode.INVALID_PRICE,
      });
      expect(await prisma.order.count({ where: { accountId } })).toBe(0);
    });

    it('needs its stop, and is the only type that takes one', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      await expect(
        stack.orders.placePending(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'STOP_LIMIT',
          volume: '1.00',
          price: '4602.00',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      await expect(
        stack.orders.placePending(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'LIMIT',
          volume: '1.00',
          price: '4550.00',
          stopPrice: '4540.00',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect(await prisma.order.count({ where: { accountId } })).toBe(0);
    });

    it('is refused by the firm’s flag, and one already resting keeps working', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const resting = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      await withTenant(TENANT, () =>
        stack.features.set({
          actorId: userId,
          actorAuthority: 'FIRM',
          key: Feature.STOP_LIMIT,
          enabled: false,
          note: 'Not at this desk',
        }),
      );
      await expect(place(userId, accountId, 'BUY', '4600.00', '4602.00')).rejects.toMatchObject({
        code: TradingErrorCode.FEATURE_DISABLED,
      });

      await moveTo('4599.90', '4600.04');
      expect((await orderOf(resting.orderId)).status).toBe(OrderStatus.FILLED);
    });
  });

  describe('activation and fill', () => {
    /**
     * The fill path's own guard, not the engine's: asked directly to fill a
     * stop-limit still waiting for its stop, at a price its limit would take,
     * it refuses. Filling there would be a stop-limit that skipped its stop.
     */
    it('is never filled before its stop, even when the price honours its limit', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4590.00');
      const outcome = await withTenant(TENANT, () =>
        stack.orders.fillPending(placed.orderId, {
          symbol: 'XAUUSD',
          bid: '4583.58',
          ask: '4583.72',
          timestamp: Date.now(),
          volume: '1',
        }),
      );
      expect(outcome).toBe('not-reached');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.PENDING);
    });

    it('does nothing while the stop is not reached', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      await moveTo('4590.00', '4590.14');
      const row = await orderOf(placed.orderId);
      expect(row.status).toBe(OrderStatus.PENDING);
      expect(row.activatedAt).toBeNull();
    });

    /**
     * A limit above the stop caps the chase: reached at 4,600.04 with the ask
     * still under 4,602, it fills on the tick that activated it — at the ask,
     * which is the limit's "or better".
     */
    it('fills on activation when the price still honours the limit', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      await moveTo('4599.90', '4600.04');

      const row = await orderOf(placed.orderId);
      expect(row.status).toBe(OrderStatus.FILLED);
      expect(row.activatedAt).not.toBeNull();
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4600.04');

      // The trail says what happened, in order, and every step is a legal edge.
      const events = await eventsOf(placed.orderId);
      expect(events.map((event) => event.type)).toEqual([
        'CREATED',
        'ACCEPTED',
        'MODIFY_REQUESTED',
        'MODIFIED',
        'TRIGGERED',
        'FILLED',
      ]);
      for (const event of events) {
        if (event.fromStatus !== null) {
          expect(canTransitionOrder(event.fromStatus, event.toStatus)).toBe(true);
        }
      }
      expect(events[3]?.payload).toMatchObject({
        activated: true,
        stopPrice: '4600',
        limitPrice: '4602',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'ORDER_ACTIVATE', resourceId: placed.orderId },
      });
      expect(audit.actorType).toBe('SYSTEM');
    });

    /**
     * The defining case. A stop gaps from 4,583 to 4,610: a stop order would
     * fill at 4,610.14. A stop-limit capped at 4,602 must not — it activates
     * and rests, and fills only when the ask comes back to 4,602 or under.
     */
    it('never fills beyond its limit on a gap through the stop', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      await moveTo('4610.00', '4610.14');

      let row = await orderOf(placed.orderId);
      expect(row.status).toBe(OrderStatus.PENDING);
      expect(row.activatedAt).not.toBeNull();
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);
      const listed = await stack.orders.listPending(userId, accountId);
      expect(listed[0]?.activatedAt).not.toBeNull();

      await moveTo('4601.80', '4601.94');
      row = await orderOf(placed.orderId);
      expect(row.status).toBe(OrderStatus.FILLED);
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4601.94');
    });

    it('waits for the pull-back when its limit is below its stop', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4595.00');
      await moveTo('4600.50', '4600.64');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.PENDING);
      expect((await orderOf(placed.orderId)).activatedAt).not.toBeNull();

      // Back under the stop is not a reason to stop waiting: the stop is spent.
      await moveTo('4597.00', '4597.14');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.PENDING);

      await moveTo('4594.80', '4594.94');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.FILLED);
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4594.94');
    });

    it('mirrors for a sell: activated by the bid falling to the stop, filled at the limit or better', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'SELL', '4570.00', '4568.00');
      await moveTo('4560.00', '4560.14');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.PENDING);
      expect((await orderOf(placed.orderId)).activatedAt).not.toBeNull();

      await moveTo('4568.20', '4568.34');
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.FILLED);
      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.entryPrice.toString()).toBe('4568.2');
    });

    /**
     * One window touched the stop and the limit and ended above both: the
     * stop was reached (detection on the extremes), and the price now does not
     * honour the limit (execution on the latest). Activated, not filled.
     */
    it('activates on a burst that touched the stop, and does not fill at a price the limit refuses', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      await burst([
        ['4583.58', '4583.72'],
        ['4600.80', '4600.94'],
        ['4608.00', '4608.14'],
      ]);
      const row = await orderOf(placed.orderId);
      expect(row.activatedAt).not.toBeNull();
      expect(row.status).toBe(OrderStatus.PENDING);
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);
    });
  });

  describe('modification and cancellation', () => {
    it('moves both prices while it waits for its stop', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      const moved = await stack.orders.modifyPending(userId, {
        orderId: placed.orderId,
        stopPrice: '4605.00',
        price: '4607.00',
      });
      expect(moved).toMatchObject({ stopPrice: '4605', price: '4607', activatedAt: null });

      // The old stop is no longer the trigger.
      await moveTo('4601.00', '4601.14');
      expect((await orderOf(placed.orderId)).activatedAt).toBeNull();
      // And a move that would put the stop behind the market is refused.
      await expect(
        stack.orders.modifyPending(userId, { orderId: placed.orderId, stopPrice: '4600.00' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_PRICE });
    });

    it('once activated, moves only its limit — and only where a limit may rest', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4595.00');
      await moveTo('4600.50', '4600.64');

      await expect(
        stack.orders.modifyPending(userId, { orderId: placed.orderId, stopPrice: '4610.00' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.ORDER_NOT_MODIFIABLE });
      // A buy limit above the ask would fill at once: refused as for any limit.
      await expect(
        stack.orders.modifyPending(userId, { orderId: placed.orderId, price: '4605.00' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_PRICE });

      const moved = await stack.orders.modifyPending(userId, {
        orderId: placed.orderId,
        price: '4597.00',
      });
      expect(moved).toMatchObject({ price: '4597', stopPrice: '4600' });
      expect(moved.activatedAt).not.toBeNull();
    });

    it('refuses a stop price on an order that has no stop of its own', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const limit = await stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
      });
      await expect(
        stack.orders.modifyPending(userId, { orderId: limit.orderId, stopPrice: '4540.00' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    /**
     * The engine decides on the stop it read. If the trader moved the stop in
     * between, that decision is about an order that no longer exists, and is
     * lost rather than applied.
     */
    it('loses an activation decided on a version the trader has since modified', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4602.00');
      const before = await orderOf(placed.orderId);
      await stack.orders.modifyPending(userId, { orderId: placed.orderId, stopPrice: '4620.00' });

      const outcome = await withTenant(TENANT, () =>
        stack.orders.activateStopLimit(placed.orderId, before.version, {
          symbol: 'XAUUSD',
          bid: '4600.00',
          ask: '4600.14',
          timestamp: Date.now(),
          volume: '1',
        }),
      );
      expect(outcome).toBe('lost');
      expect((await orderOf(placed.orderId)).activatedAt).toBeNull();
    });

    it('can be cancelled after activation, like any resting order', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const placed = await place(userId, accountId, 'BUY', '4600.00', '4595.00');
      await moveTo('4600.50', '4600.64');
      await stack.orders.cancelPending(userId, placed.orderId);
      expect((await orderOf(placed.orderId)).status).toBe(OrderStatus.CANCELLED);
    });
  });
});
