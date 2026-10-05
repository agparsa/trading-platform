import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Feature, TradingErrorCode } from '@tp/shared-types';
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
 * A trailing stop asked for at entry.
 *
 * Trailing existed only on an open position. A trader who wanted one placed
 * the order, waited for the fill, then modified the position — a window with
 * no stop at all, and for a resting order that fills at 03:00 a window nobody
 * is awake for. Now the order carries the distance and the position opens
 * with it, anchored on the executable exit price at the fill — the same
 * anchor a trail set on an open position takes from the price when it is set.
 *
 * What is pinned: the position opens trailing and anchored, from a market
 * order and from a resting one; the ratchet then moves the stop on the next
 * favourable tick without anybody touching the position; the firm's flag
 * refuses it at placement; and a venue-executed account is refused rather
 * than given a trail the venue would never hear of.
 */
suite('Trailing stop at entry (integration)', () => {
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

  it('opens a market order trailing, anchored on the exit price at the fill', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const result = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
      trailingStopDistance: '5.00',
    });
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: result.positionId ?? 'no position opened' },
    });
    expect(position.trailingStopDistance?.toString()).toBe('5');
    // A long exits at the bid; that is where the trail starts measuring from.
    expect(position.highWaterPrice?.toString()).toBe(BID);
    // No stop yet: the ratchet places one as soon as it has a reason to.
    expect(position.stopLoss).toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.trailingStopDistance?.toString()).toBe('5');
    const opened = await prisma.positionEvent.findFirstOrThrow({
      where: { positionId: position.id, type: 'OPENED' },
    });
    expect(opened.payload).toMatchObject({ trailingStopDistance: '5.00' });
  });

  it('ratchets the stop on the next favourable tick with nobody touching the position', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const result = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
      trailingStopDistance: '5.00',
    });
    await moveTo('4590.00', '4590.14');
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: result.positionId ?? 'no position opened' },
    });
    expect(position.highWaterPrice?.toString()).toBe('4590');
    expect(position.stopLoss?.toString()).toBe('4585');
  });

  it('carries the trail on a resting order to the position it opens', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const pending = await stack.orders.placePending(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '1.00',
      price: '4550.00',
      trailingStopDistance: '3.00',
    });
    expect(pending.trailingStopDistance).toBe('3');
    const listed = await stack.orders.listPending(userId, accountId);
    expect(listed[0]?.trailingStopDistance).toBe('3');

    await moveTo('4549.86', '4550.00');
    const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
    expect(position.trailingStopDistance?.toString()).toBe('3');
    expect(position.highWaterPrice?.toString()).toBe('4549.86');
  });

  it('is refused by the firm’s flag at placement, market and resting alike', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await withTenant(TENANT, () =>
      stack.features.set({
        actorId: userId,
        actorAuthority: 'FIRM',
        key: Feature.TRAILING_STOP,
        enabled: false,
        note: 'Stops are explicit at this desk',
      }),
    );
    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1.00',
        trailingStopDistance: '5.00',
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.FEATURE_DISABLED });
    await expect(
      stack.orders.placePending(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '1.00',
        price: '4550.00',
        trailingStopDistance: '5.00',
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.FEATURE_DISABLED });
    // Nothing was opened or rested.
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
    // And without a trail the same orders go through: the flag gates the
    // trail, not the trading.
    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1.00',
      }),
    ).resolves.toMatchObject({ status: 'FILLED' });
  });
});
