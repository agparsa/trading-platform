import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
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
 * The account-isolation suite.
 *
 * Every one of these cases is Mallory holding a real, valid id that belongs to
 * Alice. That is the whole threat: ids travel — in a screenshot, a support
 * ticket, a shared URL, a log line — and the system's answer must not depend on
 * whether one leaked.
 *
 * These tests are written against the *routes*, one per caller-scoped
 * operation, rather than against `AccountAccessService` alone. A resolver that
 * refuses correctly is worth nothing if one operation forgot to call it, and
 * that is exactly the failure this repository already had: `GET
 * /accounts/:id/state` was authorised only by a side effect of an unrelated
 * call. So the list below is deliberately exhaustive, and a new caller-scoped
 * operation is expected to arrive with a case here.
 */
suite('Account isolation (integration)', () => {
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

  /** Alice with a funded account and an open position; Mallory with her own. */
  async function twoTraders() {
    const alice = await createAccount(prisma, { balance: '100000' });
    const mallory = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    const pending = await stack.orders.placePending(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '1',
      price: '4000.00',
      timeInForce: 'GTC',
    });
    // A market order at an open session always fills; narrowing rather than
    // asserting non-null keeps the failure legible if it ever does not.
    if (opened.positionId === null) throw new Error('the market order did not open a position');
    return { alice, mallory, positionId: opened.positionId, orderId: pending.orderId };
  }

  async function codeOf(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
    throw new Error('the operation succeeded — it should have been refused');
  }

  it('refuses every read of an account the caller does not own', async () => {
    const { alice, mallory } = await twoTraders();

    expect(
      await codeOf(() => stack.positions.list(mallory.userId, alice.accountId, false, 50)),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
    expect(await codeOf(() => stack.positions.trades(mallory.userId, alice.accountId, 50))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(await codeOf(() => stack.orders.listPending(mallory.userId, alice.accountId))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(await codeOf(() => stack.orders.listOrders(mallory.userId, alice.accountId, 50))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(
      await codeOf(() =>
        stack.access.resolve(mallory.userId, alice.accountId, Permission.ACCOUNTS_READ),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  it('refuses every write against an account the caller does not own', async () => {
    const { alice, mallory } = await twoTraders();

    expect(
      await codeOf(() =>
        stack.orders.openPosition(mallory.userId, {
          accountId: alice.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1',
        }),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);

    expect(
      await codeOf(() =>
        stack.orders.placePending(mallory.userId, {
          accountId: alice.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'LIMIT',
          volume: '1',
          price: '4000.00',
          timeInForce: 'GTC',
        }),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  /**
   * A position id is not an account id, and the refusal must say so. Answering
   * "account not found" to someone who asked about a position would confirm
   * that the position exists and hangs off an account they may not see.
   */
  it("refuses another trader's position and calls it a missing position", async () => {
    const { alice, mallory, positionId } = await twoTraders();
    expect(alice.accountId).not.toBe(mallory.accountId);

    expect(await codeOf(() => stack.positions.close(mallory.userId, positionId, null))).toBe(
      TradingErrorCode.POSITION_NOT_FOUND,
    );
    expect(
      await codeOf(() =>
        stack.positions.modify(mallory.userId, { positionId, stopLoss: '4500.00' }),
      ),
    ).toBe(TradingErrorCode.POSITION_NOT_FOUND);
    expect(await codeOf(() => stack.positions.reverse(mallory.userId, positionId))).toBe(
      TradingErrorCode.POSITION_NOT_FOUND,
    );
  });

  it("refuses another trader's order and calls it a missing order", async () => {
    const { mallory, orderId } = await twoTraders();

    expect(await codeOf(() => stack.orders.cancelPending(mallory.userId, orderId))).toBe(
      TradingErrorCode.ORDER_NOT_FOUND,
    );
    expect(
      await codeOf(() => stack.orders.modifyPending(mallory.userId, { orderId, price: '3900.00' })),
    ).toBe(TradingErrorCode.ORDER_NOT_FOUND);
    expect(await codeOf(() => stack.orders.orderEvents(mallory.userId, orderId))).toBe(
      TradingErrorCode.ORDER_NOT_FOUND,
    );
  });

  /**
   * The refusal for "not yours" and for "does not exist" must be the same
   * response. If they differ in any observable way, an attacker with a list of
   * candidate uuids learns which ones are real accounts — the enumeration this
   * whole design exists to prevent.
   */
  it('answers "not yours" exactly as it answers "no such account"', async () => {
    const { alice, mallory } = await twoTraders();
    const absent = '00000000-0000-4000-8000-000000000000';

    const foreign = await codeOf(() =>
      stack.access.resolve(mallory.userId, alice.accountId, Permission.ACCOUNTS_READ),
    );
    const nonexistent = await codeOf(() =>
      stack.access.resolve(mallory.userId, absent, Permission.ACCOUNTS_READ),
    );
    expect(foreign).toBe(nonexistent);
  });

  it('lets the owner through on the same calls', async () => {
    const { alice, positionId, orderId } = await twoTraders();

    const grant = await stack.access.resolve(
      alice.userId,
      alice.accountId,
      Permission.POSITIONS_CLOSE,
    );
    expect(grant.via).toBe('OWNER');
    expect(grant.account.id).toBe(alice.accountId);

    await expect(
      stack.positions.list(alice.userId, alice.accountId, false, 50),
    ).resolves.toHaveLength(1);
    await expect(stack.orders.listPending(alice.userId, alice.accountId)).resolves.toHaveLength(1);
    await expect(stack.orders.orderEvents(alice.userId, orderId)).resolves.not.toHaveLength(0);
    await expect(
      stack.positions.modify(alice.userId, { positionId, stopLoss: '4000.00' }),
    ).resolves.toBeDefined();
  });

  /**
   * The resolver reads the account inside whatever transaction it is handed.
   * A resolver that always used its own connection would answer from outside
   * the caller's transaction — reading rows the transaction had not committed,
   * or missing rows it had — and would sit outside the row lock that write
   * paths take. Authorisation decided outside the lock it protects is not
   * decided.
   */
  it('resolves inside the caller transaction it is given', async () => {
    const alice = await createAccount(prisma, { balance: '1000' });

    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: alice.accountId },
        data: { status: 'CLOSE_ONLY' },
      });
      const inside = await stack.access.resolve(
        alice.userId,
        alice.accountId,
        Permission.ACCOUNTS_READ,
        tx,
      );
      expect(inside.account.status).toBe('CLOSE_ONLY');

      // The same read on the service's own connection cannot see the
      // uncommitted change, which is what makes the parameter load-bearing.
      const outside = await stack.access.resolve(
        alice.userId,
        alice.accountId,
        Permission.ACCOUNTS_READ,
      );
      expect(outside.account.status).toBe('ACTIVE');
    });
  });
});
