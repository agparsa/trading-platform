import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { TradingState } from '../../src/operations/kill-switch.service';
import { OperationsService } from '../../src/operations/operations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * The global halt.
 *
 * Almost every test here is about the same sentence: **closing is always
 * allowed**. A halt stops new risk being taken on; it does not trap traders in
 * the risk they already hold. In the circumstances a halt exists for — a feed
 * gone wrong, an engine behaving oddly, a market nobody understands — a switch
 * that also blocked closes would leave every customer unable to get out while
 * the market moved against them.
 */
suite('Kill switch (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let operator = '';

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    /**
     * Leave trading on.
     *
     * This suite halts the platform, and the halt is a row that outlives the
     * process. Cleaning up in `beforeEach` protects the next *test*; it does
     * nothing for the next *suite*, or for whoever starts the server afterwards
     * and finds every order refused with a reason from a test.
     */
    await prisma.systemSetting.deleteMany();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.systemSetting.deleteMany();
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', BID, ASK);
    operator = (await createAccount(prisma, { email: `ops-${Date.now()}@test.local` })).userId;
  });

  const halt = (reason = 'Market data looks wrong') =>
    stack.killSwitch.set(operator, TradingState.DISABLED, reason);
  const resume = () => stack.killSwitch.set(operator, TradingState.ENABLED, null);

  async function traderWithPosition() {
    const trader = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');
    return { ...trader, positionId: opened.positionId };
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

  it('starts enabled, because a platform that boots halted is a platform that is down', async () => {
    expect(stack.killSwitch.current().state).toBe(TradingState.ENABLED);
  });

  it('refuses new positions and resting orders once halted', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    await halt();

    expect(
      await codeOf(() =>
        stack.orders.openPosition(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1',
        }),
      ),
    ).toBe(TradingErrorCode.TRADING_HALTED);

    expect(
      await codeOf(() =>
        stack.orders.placePending(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          type: 'LIMIT',
          volume: '1',
          price: '4000.00',
          timeInForce: 'GTC',
        }),
      ),
    ).toBe(TradingErrorCode.TRADING_HALTED);
  });

  /**
   * The one that matters. Everything else in this file is scaffolding for it.
   */
  it('still lets a trader close a position while halted', async () => {
    const trader = await traderWithPosition();
    await halt();

    const closed = await stack.positions.close(trader.userId, trader.positionId, null);
    expect(closed.fullyClosed).toBe(true);

    const position = await prisma.position.findUniqueOrThrow({ where: { id: trader.positionId } });
    expect(position.status).toBe('CLOSED');
  });

  it('still lets a trader close part of a position while halted', async () => {
    const trader = await traderWithPosition();
    await halt();

    const closed = await stack.positions.close(trader.userId, trader.positionId, '0.4');
    expect(closed.fullyClosed).toBe(false);
  });

  /**
   * A trader who wants their resting order gone must always be able to take it
   * away. Cancelling reduces the risk they are exposed to; only moving it is a
   * new decision about where risk sits.
   */
  it('still lets a trader cancel a resting order while halted', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const pending = await stack.orders.placePending(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '1',
      price: '4000.00',
      timeInForce: 'GTC',
    });
    await halt();

    const cancelled = await stack.orders.cancelPending(trader.userId, pending.orderId);
    expect(cancelled.status).toBe('CANCELLED');

    // But moving it is refused.
    expect(
      await codeOf(() =>
        stack.orders.modifyPending(trader.userId, {
          orderId: pending.orderId,
          price: '3900.00',
        }),
      ),
    ).toBe(TradingErrorCode.TRADING_HALTED);
  });

  /**
   * A trader living through a market event most wants to tighten a stop.
   * Refusing that would trap them in risk they were trying to reduce.
   */
  it('still lets a trader tighten a stop while halted', async () => {
    const trader = await traderWithPosition();
    await halt();

    await expect(
      stack.positions.modify(trader.userId, {
        positionId: trader.positionId,
        stopLoss: '4500.00',
      }),
    ).resolves.toBeDefined();
  });

  /**
   * Reverse is a close and then an open. Letting it start would close the
   * position, hit the halt on the open, and leave the trader flat when they
   * asked to be the other way round.
   */
  it('refuses a reverse outright rather than leaving the trader flat', async () => {
    const trader = await traderWithPosition();
    await halt();

    expect(await codeOf(() => stack.positions.reverse(trader.userId, trader.positionId))).toBe(
      TradingErrorCode.TRADING_HALTED,
    );

    const position = await prisma.position.findUniqueOrThrow({ where: { id: trader.positionId } });
    expect(position.status).toBe('OPEN');
  });

  it('lets trading start again, and the trader open a position', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    await halt();
    await resume();

    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    expect(opened.positionId).not.toBeNull();
  });

  /**
   * "Who stopped trading, when, and why" is the first question after any halt,
   * and "who started it again" is the second. An answer that lives only in
   * somebody's memory is not an answer.
   */
  it('audits both directions, with the reason', async () => {
    await halt('The gold feed is stale');
    await resume();

    const events = await prisma.auditLog.findMany({
      where: { resourceType: 'System' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'system.trading_halted',
      'system.trading_resumed',
    ]);
    expect(events.every((e) => e.actorId === operator)).toBe(true);
    expect(JSON.stringify(events[0]?.after)).toContain('The gold feed is stale');
  });

  it('survives a restart, because the state is stored rather than remembered', async () => {
    await halt('Held across a restart');

    // A second stack is a second process, as far as the switch is concerned.
    const restarted = await buildTradingStack(prisma);
    await restarted.killSwitch.refresh();

    expect(restarted.killSwitch.current().state).toBe(TradingState.DISABLED);
    expect(restarted.killSwitch.current().reason).toBe('Held across a restart');
  });

  it('names the halt in the refusal, so a trader is not left guessing', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    await halt('Scheduled maintenance');
    try {
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as DomainError).message;
      expect(message).toContain('Scheduled maintenance');
      // And tells them what they can still do.
      expect(message.toLowerCase()).toContain('closed');
    }
  });

  it('reports the halt on the operations summary', async () => {
    const operations = new OperationsService(prisma as unknown as PrismaService, stack.killSwitch);
    await halt('Feed check');

    const summary = await operations.summary();
    expect(summary.trading.state).toBe(TradingState.DISABLED);
    expect(summary.trading.reason).toBe('Feed check');
    expect(summary.accounts.total).toBeGreaterThan(0);
  });
});
