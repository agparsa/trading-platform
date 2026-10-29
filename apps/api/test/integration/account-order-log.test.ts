import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TradingController } from '../../src/trading/trading.controller';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * `GET /accounts/:id/order-events` — the terminal's Logs tab.
 *
 * Driven through the controller, so the route's own parameters (the caller,
 * the account, the page size, the cursor) are what is tested.
 */
suite("An account's order log, read by its owner (integration)", () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let controller: TradingController;

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
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    controller = new TradingController(
      stack.access,
      stack.orders,
      stack.positions,
      stack.accountState,
      undefined as never,
      stack.metrics as never,
    );
  });

  const asUser = (id: string) => ({ id }) as never;

  async function readAll(userId: string, accountId: string, limit: number) {
    const seen: Array<{ id: string; orderId: string; type: string; symbol: string }> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await controller.orderLog(asUser(userId), accountId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      } as never);
      seen.push(...page.events);
      if (page.nextCursor === undefined) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('the log never ran out of pages');
  }

  /**
   * A market order writes its whole trail in one transaction, so its rows
   * share one `createdAt`. Newest first must still put Filled above Placed,
   * and a page boundary inside the group must not repeat or skip a row.
   */
  it('reads every order newest first, each trail in reverse write order, across pages', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    const pending = await stack.orders.placePending(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '1',
      price: '4000.00',
      timeInForce: 'GTC',
    });
    await stack.orders.cancelPending(userId, pending.orderId);

    const stored = await prisma.orderEvent.count({ where: { order: { accountId } } });
    const whole = await readAll(userId, accountId, 200);
    expect(whole).toHaveLength(stored);

    // The cancelled limit is the newest order; its Cancelled is the top line.
    expect(whole[0]).toMatchObject({
      orderId: pending.orderId,
      type: 'CANCELLED',
      symbol: 'XAUUSD',
    });
    // Within each order, newest first: the reverse of its own trail.
    for (const orderId of new Set(whole.map((row) => row.orderId))) {
      const trail = (await stack.orders.orderEvents(userId, orderId)).map((row) => row.type);
      expect(whole.filter((row) => row.orderId === orderId).map((row) => row.type)).toEqual(
        [...trail].reverse(),
      );
    }

    for (const limit of [1, 2, 3]) {
      const paged = await readAll(userId, accountId, limit);
      expect(
        paged.map((row) => row.id),
        `${limit} to a page`,
      ).toEqual(whole.map((row) => row.id));
    }
  });

  it("shows only this account's orders", async () => {
    const alice = await createAccount(prisma, { balance: '100000' });
    const bob = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(bob.userId, {
      accountId: bob.accountId,
      symbol: 'XAUUSD',
      side: 'SELL',
      volume: '1',
    });
    const page = await controller.orderLog(asUser(alice.userId), alice.accountId, {
      limit: 50,
    } as never);
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
