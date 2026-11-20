import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
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
 * Commission schedules, as the engine charges them.
 *
 * Driven through the real order and close paths: the point of a schedule is
 * what lands in the ledger, so that is what is read.
 */
suite('Fee schedules (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  /** A real person to act as: the audit log refers to its actor. */
  let ACTOR: string;

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
    ACTOR = (await createAccount(prisma, { email: 'fees-admin@test.local' })).userId;
  });

  async function commissionsOf(accountId: string): Promise<string[]> {
    const rows = await prisma.balanceLedger.findMany({
      where: { accountId, type: 'COMMISSION' },
      orderBy: { createdAt: 'asc' },
      select: { amount: true },
    });
    return rows.map((row) => row.amount.toFixed(2));
  }

  async function open(userId: string, accountId: string, volume = '2') {
    const result = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });
    if (result.positionId === null) throw new Error('the market order did not open');
    return result.positionId;
  }

  it('charges the schedule’s rate on both legs, and leaves other accounts on the standard terms', async () => {
    const vip = await createAccount(prisma, { balance: '100000' });
    const standard = await createAccount(prisma, { balance: '100000' });
    const schedule = await stack.fees.save(ACTOR, {
      name: 'VIP',
      rules: [{ symbol: 'XAUUSD', commissionPerLot: '1.25' }],
    });
    await stack.fees.assign(ACTOR, vip.accountId, schedule.id, 'agreed tier');

    const vipPosition = await open(vip.userId, vip.accountId);
    await open(standard.userId, standard.accountId);
    await stack.positions.close(vip.userId, vipPosition, null);

    // 2 lots at 1.25 per lot, opening and closing.
    expect(await commissionsOf(vip.accountId)).toEqual(['-2.50', '-2.50']);
    const spec = await prisma.symbolSpec.findFirstOrThrow({
      where: { symbol: { code: 'XAUUSD' } },
    });
    const standardRate = spec.commissionPerLot.mul(2);
    expect(await commissionsOf(standard.accountId)).toEqual(
      standardRate.isZero() ? [] : [standardRate.negated().toFixed(2)],
    );
  });

  it('uses the schedule’s default for an instrument it has no rule for, and the standard terms when it has neither', async () => {
    const withDefault = await createAccount(prisma, { balance: '100000' });
    const withNothing = await createAccount(prisma, { balance: '100000' });
    const flat = await stack.fees.save(ACTOR, {
      name: 'Flat',
      defaultCommissionPerLot: '3',
      rules: [],
    });
    const empty = await stack.fees.save(ACTOR, { name: 'Empty', rules: [] });
    await stack.fees.assign(ACTOR, withDefault.accountId, flat.id, 'flat rate');
    await stack.fees.assign(ACTOR, withNothing.accountId, empty.id, 'nothing set');

    await open(withDefault.userId, withDefault.accountId, '1');
    await open(withNothing.userId, withNothing.accountId, '1');

    expect(await commissionsOf(withDefault.accountId)).toEqual(['-3.00']);
    const spec = await prisma.symbolSpec.findFirstOrThrow({
      where: { symbol: { code: 'XAUUSD' } },
    });
    expect(await commissionsOf(withNothing.accountId)).toEqual(
      spec.commissionPerLot.isZero() ? [] : [spec.commissionPerLot.negated().toFixed(2)],
    );
  });

  it('a free schedule charges nothing at all', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const free = await stack.fees.save(ACTOR, {
      name: 'Free',
      rules: [{ symbol: 'XAUUSD', commissionPerLot: '0' }],
    });
    await stack.fees.assign(ACTOR, trader.accountId, free.id, 'promotion');
    const position = await open(trader.userId, trader.accountId);
    await stack.positions.close(trader.userId, position, null);
    expect(await commissionsOf(trader.accountId)).toEqual([]);
  });

  it('refuses to delete a schedule an account pays, and audits every change', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const schedule = await stack.fees.save(ACTOR, {
      name: 'Desk A',
      rules: [{ symbol: 'XAUUSD', commissionPerLot: '2' }],
    });
    await stack.fees.assign(ACTOR, trader.accountId, schedule.id, 'desk');
    await expect(stack.fees.remove(ACTOR, schedule.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await stack.fees.assign(ACTOR, trader.accountId, null, 'back to standard');
    await stack.fees.remove(ACTOR, schedule.id);
    expect(await prisma.feeSchedule.count()).toBe(0);

    const actions = (
      await prisma.auditLog.findMany({ select: { action: true }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'FEE_SCHEDULE_CREATED',
        'ACCOUNT_FEE_SCHEDULE_CHANGED',
        'FEE_SCHEDULE_DELETED',
      ]),
    );
  });

  it('refuses an unknown instrument, a negative rate and a duplicate name', async () => {
    await expect(
      stack.fees.save(ACTOR, { name: 'X', rules: [{ symbol: 'NOPE', commissionPerLot: '1' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      stack.fees.save(ACTOR, { name: 'X', rules: [{ symbol: 'XAUUSD', commissionPerLot: '-1' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await stack.fees.save(ACTOR, { name: 'Same', rules: [] });
    await expect(stack.fees.save(ACTOR, { name: 'Same', rules: [] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports commission and swap by currency, instrument and account, from the ledger', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const schedule = await stack.fees.save(ACTOR, {
      name: 'Report',
      rules: [{ symbol: 'XAUUSD', commissionPerLot: '1.25' }],
    });
    await stack.fees.assign(ACTOR, trader.accountId, schedule.id, 'report');
    const position = await open(trader.userId, trader.accountId);
    await stack.positions.close(trader.userId, position, null);

    const now = new Date();
    const report = await stack.fees.report(
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() + 60_000),
    );
    expect(report.totals).toEqual([{ currency: 'USD', commission: '5.00', swap: '0.00' }]);
    expect(report.bySymbol).toEqual([
      { symbol: 'XAUUSD', currency: 'USD', commission: '5.00', swap: '0.00' },
    ]);
    expect(report.topAccounts.find((row) => row.accountId === trader.accountId)).toMatchObject({
      accountId: trader.accountId,
      schedule: 'Report',
      commission: '5.00',
    });
    await expect(
      stack.fees.report(new Date('2025-01-01'), new Date('2026-06-01')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
