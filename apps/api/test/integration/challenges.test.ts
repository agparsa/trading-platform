import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { ChallengesService, type PlanInput } from '../../src/challenges/challenges.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
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

const PLAN: PlanInput = {
  name: '10K two-step',
  steps: 2,
  accountSize: '10000',
  accountCurrency: 'USD',
  leverage: 100,
  price: '99',
  paymentAsset: 'USDT',
  paymentNetwork: 'TRC20',
  paymentAddress: 'TXYZabcdefghijklmnopqrstuvwxyz1234',
  phaseOneTargetPct: '8',
  phaseTwoTargetPct: '4',
  dailyLossPct: '5',
  maxLossPct: '10',
  drawdownMode: 'STATIC',
  trailingLock: false,
  dailyBasis: 'BALANCE',
  minTradingDays: 0,
  maxDays: 30,
  profitSplitPct: '80',
  isActive: true,
};

const HASH = 'a'.repeat(64);

/**
 * A challenge from purchase to a passed phase and a failed one, against the
 * real trading engine: the evaluator decides from what the account actually
 * did, not from figures written into the test.
 */
suite('Prop challenges (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let service: ChallengesService;
  const raised: Array<{ kind: string; userId: string }> = [];

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
    raised.length = 0;
    const p = prisma as unknown as PrismaService;
    const config = new ConfigService({ TRADING_SERVER_TIMEZONE: 'UTC' });
    service = new ChallengesService(
      p,
      new AccountsService(p, stack.access, new LedgerService(), config as never),
      stack.accountState,
      stack.quotes,
      new AuditService(p),
      {
        raise: async (job: { kind: string; userId: string }) => {
          raised.push(job);
        },
      } as unknown as NotificationsService,
      config as never,
    );
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
  });

  async function paidChallenge() {
    const admin = await createAccount(prisma, { email: `admin-${Date.now()}@test.local` });
    const trader = await createAccount(prisma);
    const plan = await service.createPlan(admin.userId, PLAN);
    const bought = await service.purchase(trader.userId, plan.id);
    await service.submitPayment(trader.userId, bought.id, HASH);
    await service.decidePayment(admin.userId, bought.id, true, null);
    return { admin, trader, plan, id: bought.id };
  }

  async function trade(userId: string, accountId: string, exitBid: string) {
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    await stack.publishQuote('XAUUSD', exitBid, (Number(exitBid) + 0.14).toFixed(2));
    return opened.positionId!;
  }

  it('sells a plan, waits for a person to confirm the fee, then opens phase 1', async () => {
    const admin = await createAccount(prisma, { email: 'desk@test.local' });
    const trader = await createAccount(prisma);
    const plan = await service.createPlan(admin.userId, PLAN);
    expect((await service.offered()).map((p) => p.id)).toEqual([plan.id]);

    const bought = await service.purchase(trader.userId, plan.id);
    expect(bought.status).toBe('AWAITING_PAYMENT');
    expect(bought.payment.address).toBe(PLAN.paymentAddress);
    // A double click is one challenge.
    expect((await service.purchase(trader.userId, plan.id)).id).toBe(bought.id);

    await service.submitPayment(trader.userId, bought.id, HASH);
    expect((await service.one(trader.userId, bought.id)).status).toBe('PAYMENT_REVIEW');
    // Nothing is opened on the trader's word.
    expect(await prisma.account.count({ where: { userId: trader.userId } })).toBe(1);

    const decided = await service.decidePayment(admin.userId, bought.id, true, null);
    expect(decided.status).toBe('ACTIVE');
    expect(decided.phase).toBe('PHASE_ONE');
    const account = await prisma.account.findUniqueOrThrow({ where: { id: decided.accountId! } });
    expect(account.balance.toString()).toBe('10000');
    expect(account.leverage).toBe(100);

    // Deciding twice is refused, not repeated.
    await expect(service.decidePayment(admin.userId, bought.id, true, null)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === TradingErrorCode.CONCURRENT_MODIFICATION,
    );
    const audit = await prisma.auditLog.findMany({
      where: { resourceId: bought.id },
      select: { action: true },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['challenge.purchased', 'challenge.payment_confirmed']),
    );
  });

  it('refuses one transfer for two challenges, and another trader’s challenge', async () => {
    const { trader, plan, id } = await paidChallenge();
    const other = await createAccount(prisma);
    const theirs = await service.purchase(other.userId, plan.id);
    await expect(service.submitPayment(other.userId, theirs.id, HASH)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === TradingErrorCode.VALIDATION_FAILED,
    );
    await expect(service.one(other.userId, id)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    expect((await service.mine(trader.userId)).map((c) => c.id)).toEqual([id]);
  });

  it('passes phase 1 on closed profit, certifies it, and opens phase 2', async () => {
    const { trader, id } = await paidChallenge();
    const start = await service.one(trader.userId, id);
    const accountId = start.accountId!;

    expect((await service.evaluate(id)).kind).toBe('ONGOING');

    const positionId = await trade(trader.userId, accountId, '4592.50');
    // Floating profit past the target does not pass.
    expect((await service.evaluate(id)).kind).toBe('ONGOING');
    await stack.positions.close(trader.userId, positionId, null);

    const outcome = await service.evaluate(id);
    expect(outcome).toEqual({ kind: 'ADVANCED', to: 'PHASE_TWO' });

    const after = await service.one(trader.userId, id);
    expect(after.phase).toBe('PHASE_TWO');
    expect(after.status).toBe('ACTIVE');
    expect(after.accountId).not.toBe(accountId);
    expect(after.certificates).toHaveLength(1);
    expect(after.rules.profitTargetPct).toBe('4');
    const old = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(old.status).toBe('CLOSE_ONLY');
    const fresh = await prisma.account.findUniqueOrThrow({ where: { id: after.accountId! } });
    expect(fresh.balance.toString()).toBe('10000');

    const certificate = await service.certificate(after.certificates[0]!.code);
    expect(certificate).toMatchObject({ phase: 'PHASE_ONE', accountSize: '10000' });
    expect(raised.map((r) => r.kind)).toContain('challenge.passed');
  });

  it('fails on the daily loss, marked to market, and stops new risk', async () => {
    const { trader, id } = await paidChallenge();
    const { accountId } = await service.one(trader.userId, id);
    await trade(trader.userId, accountId!, '4578.00'); // about −572 on 10,000

    expect(await service.evaluate(id)).toEqual({ kind: 'FAILED', rule: 'DAILY_LOSS' });
    const after = await service.one(trader.userId, id);
    expect(after.status).toBe('FAILED');
    expect(after.failedRule).toBe('DAILY_LOSS');
    expect(after.events.map((e) => e.kind)).toContain('RULE_BREACHED');
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId! } });
    expect(account.status).toBe('CLOSE_ONLY');
    // Once ended, it is not evaluated again.
    expect((await service.evaluate(id)).kind).toBe('DEFERRED');
  });

  it('never fails a challenge on a price it cannot see', async () => {
    const { trader, id } = await paidChallenge();
    const { accountId } = await service.one(trader.userId, id);
    await trade(trader.userId, accountId!, '4500.00'); // a loss far past every limit…
    // …but no price to judge it by: gone from the process and the cache.
    stack.quotes.forget('XAUUSD');
    await stack.redis.client.del('quote:XAUUSD');

    expect((await service.evaluate(id)).kind).toBe('DEFERRED');
    expect((await service.one(trader.userId, id)).status).toBe('ACTIVE');

    // An old price is no better than none.
    await stack.publishQuote('XAUUSD', '4500.00', '4500.14', Date.now() - 10 * 60_000);
    expect((await service.evaluate(id)).kind).toBe('DEFERRED');
    expect((await service.one(trader.userId, id)).status).toBe('ACTIVE');
  });

  it('keeps the history: events cannot be rewritten', async () => {
    const { id } = await paidChallenge();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE challenge_events SET kind = 'X' WHERE challenge_id = '${id}'`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a plan whose rules contradict each other', async () => {
    const admin = await createAccount(prisma);
    await expect(
      service.createPlan(admin.userId, { ...PLAN, dailyLossPct: '12' }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === TradingErrorCode.VALIDATION_FAILED,
    );
    await expect(
      service.createPlan(admin.userId, { ...PLAN, paymentAddress: null }),
    ).rejects.toThrow(/payment address/);
  });
});
