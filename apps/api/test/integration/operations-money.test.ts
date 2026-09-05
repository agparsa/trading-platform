import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withTenant } from '@tp/tenancy';
import { AuditService } from '../../src/common/audit/audit.service';
import { KillSwitchService } from '../../src/operations/kill-switch.service';
import { OperationsService } from '../../src/operations/operations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The money on the dashboard.
 *
 * Until this phase the operator's page was counts only — it could say how many
 * orders were rejected in the last hour and not what the firm was holding or
 * what dealing had earned it, which are the first two questions anyone running
 * one asks.
 *
 * The trap in adding them is currency. A firm holding dollars and euros has
 * two numbers, and one number made by adding them looks authoritative and
 * reconciles with nothing. So these tests are mostly about the arithmetic
 * staying separated.
 */
suite('Operations money summary (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let operations: OperationsService;

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

    const prismaService = prisma as unknown as PrismaService;
    operations = new OperationsService(
      prismaService,
      new KillSwitchService(prismaService, new AuditService(prismaService)),
    );
  });

  const of = async (currency: string) =>
    (await operations.summary()).money.byCurrency.find((row) => row.currency === currency);

  it('reports what the firm holds, by currency', async () => {
    await createAccount(prisma, { balance: '100000', email: `a-${Date.now()}@test.local` });
    await createAccount(prisma, { balance: '50000', email: `b-${Date.now()}@test.local` });
    await createAccount(prisma, {
      balance: '30000',
      currency: 'EUR',
      email: `c-${Date.now()}@test.local`,
    });

    const summary = await operations.summary();
    expect(summary.money.byCurrency.map((row) => row.currency)).toEqual(['EUR', 'USD']);
    expect(Number((await of('USD'))?.balance)).toBe(150_000);
    expect(Number((await of('EUR'))?.balance)).toBe(30_000);
    // Two currencies, two figures. There is no combined total anywhere in the
    // payload, because there is no rate here to make one honestly.
    expect(JSON.stringify(summary.money)).not.toContain('180000');
  });

  it('reports what dealing earned, and what a round trip cost', async () => {
    const alice = await createAccount(prisma, {
      balance: '1000000',
      email: `a-${Date.now()}@test.local`,
    });
    const opened = await stack.orders.openPosition(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.50',
    });
    await stack.positions.close(alice.userId, opened.positionId as string, null);

    const usd = await of('USD');
    expect(usd?.closedTradesLastDay).toBe(1);
    expect(Number(usd?.volumeLastDay)).toBe(0.5);
    // Commission and net P&L are the firm's side and the trader's side of the
    // same round trip, and both are here rather than only the count.
    expect(usd?.commissionLastDay).toMatch(/^-?\d/);
    expect(usd?.netPnlLastDay).toMatch(/^-?\d/);
  });

  it('shows what left as a positive number under "withdrawn"', async () => {
    const alice = await createAccount(prisma, {
      balance: '100000',
      email: `a-${Date.now()}@test.local`,
    });
    // Withdrawals are negative ledger entries; a negative under a heading that
    // says "withdrawn" reads as money arriving.
    await prisma.balanceLedger.create({
      data: {
        // The tenancy extension supplies the tenant; naming it here as well is
        // what a caller must not do. The cast is the price of that: Prisma's
        // input type still wants a tenant it will never see.
        accountId: alice.accountId,
        type: 'WITHDRAWAL',
        amount: '-2500',
        balanceAfter: '97500',
        currency: 'USD',
      } as never,
    });

    const usd = await of('USD');
    expect(usd?.withdrawnLastDay).toBe('2500');
    expect(usd?.depositedLastDay).not.toBe('0');
  });

  it('counts nothing from another firm', async () => {
    await createAccount(prisma, { balance: '100000', email: `a-${Date.now()}@test.local` });
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      const summary = await operations.summary();
      expect(summary.money.byCurrency).toEqual([]);
      expect(summary.accounts.total).toBe(0);
    });
  });

  it('reports an empty firm as no currencies rather than a zero in one it does not hold', async () => {
    const summary = await operations.summary();
    expect(summary.money.byCurrency).toEqual([]);
  });
});
