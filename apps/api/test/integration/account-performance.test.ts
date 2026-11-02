import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Money } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PerformanceController } from '../../src/trading/performance.controller';
import { PerformanceService } from '../../src/trading/performance.service';
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

/**
 * `GET /accounts/:id/performance` — the Analytics page.
 *
 * Driven through the controller, against trades the engine really closed, so
 * the figures are checked against the rows they are made from rather than
 * against numbers written into the test.
 */
suite("An account's performance (integration)", () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let controller: PerformanceController;

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
    controller = new PerformanceController(
      new PerformanceService(
        prisma as unknown as PrismaService,
        stack.access,
        new ConfigService({ TRADING_SERVER_TIMEZONE: 'UTC' }) as never,
      ),
    );
  });

  const asUser = (id: string) => ({ id }) as never;

  async function roundTrip(
    userId: string,
    accountId: string,
    side: 'BUY' | 'SELL',
    exit: [string, string],
  ) {
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side,
      volume: '0.10',
    });
    await stack.publishQuote('XAUUSD', exit[0], exit[1]);
    await stack.positions.close(userId, opened.positionId!, null);
  }

  it('sums, counts and averages exactly the trades the engine closed', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '10000' });
    await roundTrip(userId, accountId, 'BUY', ['4600.00', '4600.14']); // win
    await roundTrip(userId, accountId, 'BUY', ['4570.00', '4570.14']); // loss
    await roundTrip(userId, accountId, 'SELL', ['4560.00', '4560.14']); // win

    const rows = await prisma.trade.findMany({ where: { accountId } });
    expect(rows).toHaveLength(3);
    const net = Money.sum(
      rows.map((row) => Money.of(row.netPnl.toString(), 'USD')),
      'USD',
    );

    const result = await controller.forAccount(asUser(userId), accountId, {
      period: '3M',
    } as never);
    expect(result.trades).toEqual({
      total: 3,
      buys: { total: 2, profitable: 1, losing: 1 },
      sells: { total: 1, profitable: 1, losing: 0 },
    });
    expect(result.netPnl).toBe(net.toString());
    expect(result.days).toMatchObject({ total: 1 });
    expect(result.months).toHaveLength(1);
    expect(result.profitFactor).not.toBeNull();
  });

  /**
   * The return is measured against the balance the period began with, read
   * from the ledger. An account opened inside the period has no such balance,
   * and "All" has no start at all: both say so with null, not with a figure
   * computed against zero or against today's balance.
   */
  it('states a return only against a balance the ledger had before the period', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '10000' });
    await roundTrip(userId, accountId, 'BUY', ['4600.00', '4600.14']);
    const fresh = await controller.forAccount(asUser(userId), accountId, { period: '3M' } as never);
    expect(fresh.returnPercent).toBeNull();

    // An entry dated before the period: now there is a balance to start from.
    // (The ledger is append-only — an insert, not an edit.)
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    await prisma.balanceLedger.create({
      data: {
        tenantId: account.tenantId,
        accountId,
        type: 'DEPOSIT',
        amount: '8000',
        balanceAfter: '8000',
        currency: 'USD',
        createdAt: new Date(Date.now() - 200 * 86_400_000),
      },
    });
    const dated = await controller.forAccount(asUser(userId), accountId, { period: '3M' } as never);
    expect(Money.of(dated.startingBalance!, 'USD').toString()).toBe('8000.00');
    expect(dated.returnPercent).toBe(
      Money.of(dated.netPnl, 'USD').amount.dividedBy(8000).times(100).toFixed(2),
    );

    const all = await controller.forAccount(asUser(userId), accountId, { period: 'ALL' } as never);
    expect(all.returnPercent).toBeNull();
    expect(all.from).toBeNull();
  });

  it("counts only this account's trades, and refuses another trader's account", async () => {
    const alice = await createAccount(prisma, { balance: '10000' });
    const mallory = await createAccount(prisma, { balance: '10000' });
    await roundTrip(mallory.userId, mallory.accountId, 'BUY', ['4600.00', '4600.14']);
    const own = await controller.forAccount(asUser(alice.userId), alice.accountId, {
      period: 'ALL',
    } as never);
    expect(own.trades.total).toBe(0);

    await expect(
      controller.forAccount(asUser(mallory.userId), alice.accountId, { period: '3M' } as never),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DomainError && error.code === TradingErrorCode.RESOURCE_NOT_FOUND,
    );
  });
});
