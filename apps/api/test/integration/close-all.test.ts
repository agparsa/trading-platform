import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TradingErrorCode } from '@tp/shared-types';
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
 * Close everything.
 *
 * It was a loop in the browser: one request per position, partial failure
 * swallowed. A trader who pressed it in a fast market got some closed and some
 * not, with no record of what they had asked for, and a dropped connection
 * halfway through left the rest open under a screen that said the button had
 * been pressed.
 *
 * As a server command it states the intent once and reports the outcome per
 * position. What these tests pin is that honesty: it does not claim to be
 * atomic, it does not stop at the first refusal, and it does not close what it
 * was not asked to.
 */
suite('Close all (integration)', () => {
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

  const buy = (userId: string, accountId: string, volume = '0.10') =>
    stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });

  it('closes every open position and says how many it was asked to', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    for (let i = 0; i < 3; i += 1) await buy(userId, accountId);

    const result = await stack.positions.closeAll(userId, accountId);
    expect(result.asked).toBe(3);
    expect(result.closed).toHaveLength(3);
    expect(result.refused).toEqual([]);
    expect(await prisma.position.count({ where: { accountId, status: 'OPEN' } })).toBe(0);
    // Each close is a real close: a trade row, a ledger entry, an exit price.
    expect(await prisma.trade.count({ where: { accountId } })).toBe(3);
    expect(result.closed.every((one) => Number(one.exitPrice) > 0)).toBe(true);
  });

  it('closes nothing and refuses nothing on an account with no positions', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000' });
    expect(await stack.positions.closeAll(userId, accountId)).toEqual({
      asked: 0,
      closed: [],
      refused: [],
    });
  });

  /**
   * The whole reason this is not one transaction. One instrument that cannot
   * be priced must not roll back closes that already happened at real prices —
   * and it must not be silent either.
   */
  it('keeps the closes that worked when one position cannot be closed, and says which', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await buy(userId, accountId);
    await buy(userId, accountId);
    // A third position in a second instrument, whose price then disappears —
    // the shape of a feed gap, and the reason this command is not one
    // transaction.
    const gold = await prisma.symbol.findUniqueOrThrow({
      where: { code: 'XAUUSD' },
      include: { spec: true, sessions: true },
    });
    const silver = await prisma.symbol.create({
      data: {
        code: 'XAGUSD',
        description: 'Silver vs US Dollar',
        category: 'Metals',
        quoteCurrency: 'USD',
      },
    });
    const { symbolId: _ignored, ...spec } = gold.spec as unknown as Record<string, unknown>;
    await prisma.symbolSpec.create({ data: { ...spec, symbolId: silver.id } as never });
    await prisma.marketSession.createMany({
      data: gold.sessions.map((session) => ({
        symbolId: silver.id,
        timezone: session.timezone,
        dayOfWeek: session.dayOfWeek,
        openMinute: session.openMinute,
        closeMinute: session.closeMinute,
      })),
    });
    await stack.symbols.reload();
    await stack.publishQuote('XAGUSD', '31.20', '31.24');
    const stranded = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAGUSD',
      side: 'BUY',
      volume: '0.10',
    });
    stack.quotes.forget('XAGUSD');
    await stack.redis.client.del('quote:XAGUSD');

    const result = await stack.positions.closeAll(userId, accountId);
    expect(result.asked).toBe(3);
    expect(result.closed).toHaveLength(2);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({
      positionId: stranded.positionId,
      code: TradingErrorCode.NO_QUOTE_AVAILABLE,
    });
    // The refusal carries a reason a person can read, not only a code.
    expect(result.refused[0]?.message.length).toBeGreaterThan(0);

    // The two that closed are closed; the one that could not is still open and
    // still tradeable — not stranded in CLOSING.
    expect(await prisma.position.count({ where: { accountId, status: 'OPEN' } })).toBe(1);
    expect(await prisma.position.count({ where: { accountId, status: 'CLOSING' } })).toBe(0);
  });

  it('touches no other account, even the same trader’s', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await buy(userId, accountId);
    const second = await prisma.account.create({
      data: {
        userId,
        number: `TP-9${Date.now().toString().slice(-6)}`,
        type: 'DEMO',
        currency: 'USD',
        balance: '1000000',
        leverage: 100,
      } as never,
    });
    await prisma.accountSettings.create({ data: { accountId: second.id } as never });
    await buy(userId, second.id);

    const result = await stack.positions.closeAll(userId, accountId);
    expect(result.asked).toBe(1);
    expect(await prisma.position.count({ where: { accountId: second.id, status: 'OPEN' } })).toBe(1);
  });

  it('refuses an account the caller may not close on, before anything moves', async () => {
    const mine = await createAccount(prisma, { balance: '1000000', email: `m-${Date.now()}@t.local` });
    const theirs = await createAccount(prisma, {
      balance: '1000000',
      email: `t-${Date.now()}@t.local`,
    });
    await buy(theirs.userId, theirs.accountId);

    await expect(stack.positions.closeAll(mine.userId, theirs.accountId)).rejects.toMatchObject({
      code: TradingErrorCode.RESOURCE_NOT_FOUND,
    });
    expect(
      await prisma.position.count({ where: { accountId: theirs.accountId, status: 'OPEN' } }),
    ).toBe(1);
  });

  it('records the intent, not only the closes it produced', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await buy(userId, accountId);
    await buy(userId, accountId);
    await stack.positions.closeAll(userId, accountId);

    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'POSITION_CLOSE_ALL' },
    });
    expect(trail.actorId).toBe(userId);
    expect(trail.resourceId).toBe(accountId);
    // What was asked for as well as what happened — the thing a burst of
    // unrelated closes could never show.
    expect(trail.after).toMatchObject({ asked: 2, closed: 2 });
  });

  /**
   * Largest first. If the account is near a stop-out, releasing the most
   * margin soonest is what makes the rest closeable rather than liquidated
   * halfway through by the engine.
   */
  it('closes the heaviest position first', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await buy(userId, accountId, '0.10');
    const heavy = await buy(userId, accountId, '1.00');
    await buy(userId, accountId, '0.20');

    const result = await stack.positions.closeAll(userId, accountId);
    expect(result.closed[0]?.positionId).toBe(heavy.positionId);
  });
});
