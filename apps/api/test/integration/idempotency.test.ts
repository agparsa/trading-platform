import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { TradingErrorCode, type DomainError } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { runInRequestScope } from '../../src/common/request-scope';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  TEST_DATABASE_URL,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };
const SCOPE = 'orders:test-user';

/**
 * The idempotency claim, and the crash it exists to survive.
 *
 * Failure injection found the window: 39 of 40 orders had committed when the
 * process was killed, none of their claims said so, every retry with the same
 * key was refused as "still in flight", and a client following the only
 * remaining path — a fresh key — would have filled each of them again. What
 * these tests pin is the closing of that window: the claim commits *with* the
 * order, a retry that finds it is refused rather than run, and a claim a crash
 * left behind before any commit is taken over rather than blocking for a day.
 */
suite('idempotency', () => {
  let prisma: PrismaClient;
  let service: IdempotencyService;

  const config = (over: Record<string, unknown> = {}) =>
    new ConfigService({
      IDEMPOTENCY_KEY_TTL_SECONDS: 86_400,
      IDEMPOTENCY_TAKEOVER_AFTER_MS: 60_000,
      ...over,
    } as never) as never;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    service = new IdempotencyService(prisma as unknown as PrismaService, config());
  });

  const claim = <T>(key: string, body: unknown = { volume: '0.10' }) =>
    withTenant(TENANT, () => service.claim<T>(SCOPE, key, body));

  const row = (key: string) =>
    prisma.idempotencyKey.findUniqueOrThrow({
      where: { tenantId_scope_key: { tenantId: DEFAULT_TENANT_ID, scope: SCOPE, key } },
    });

  const failure = async (promise: Promise<unknown>): Promise<DomainError> => {
    try {
      await promise;
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  };

  it('replays a completed claim and refuses the same key with a different body', async () => {
    const first = await claim<{ orderId: string }>('k1');
    expect(first.kind).toBe('fresh');
    if (first.kind !== 'fresh') return;
    await first.complete({ orderId: 'o1' });

    const again = await claim<{ orderId: string }>('k1');
    expect(again).toEqual({ kind: 'replayed', result: { orderId: 'o1' } });

    const altered = await failure(claim('k1', { volume: '0.20' }));
    expect(altered.code).toBe(TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    expect(altered.message).toMatch(/different request body/);
  });

  it('refuses a retry while a fresh claim is in flight', async () => {
    await claim('k2');
    const second = await failure(claim('k2'));
    expect(second.code).toBe(TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    expect(second.message).toMatch(/still in flight/);
  });

  /**
   * A claim the transaction marked COMMITTED and the crash left without a
   * result. The effects exist; the answer does not. Neither running again nor
   * inventing an answer is acceptable, so the refusal has its own code.
   */
  it('refuses, with its own code, a claim whose effects committed but whose result was never recorded', async () => {
    const first = await claim('k3');
    expect(first.kind).toBe('fresh');
    await prisma.idempotencyKey.updateMany({
      where: { scope: SCOPE, key: 'k3' },
      data: { status: 'COMMITTED' },
    });

    const retry = await failure(claim('k3'));
    expect(retry.code).toBe(TradingErrorCode.IDEMPOTENCY_RESULT_UNAVAILABLE);
    expect(retry.message).toMatch(/already applied/);
  });

  /**
   * The other crash: before anything committed. A claim that old with nothing
   * committed belongs to nobody, and blocking every retry for the key's whole
   * lifetime was what pushed clients towards a fresh key.
   */
  it('lets a retry take over a claim left IN_PROGRESS longer than the takeover window', async () => {
    await claim('k4');
    await prisma.idempotencyKey.updateMany({
      where: { scope: SCOPE, key: 'k4' },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });

    const retry = await claim<{ orderId: string }>('k4');
    expect(retry.kind).toBe('fresh');
    if (retry.kind !== 'fresh') return;
    await retry.complete({ orderId: 'o4' });
    expect((await row('k4')).status).toBe('COMPLETED');
  });

  it('does not take over a claim that is merely a little old', async () => {
    await claim('k5');
    await prisma.idempotencyKey.updateMany({
      where: { scope: SCOPE, key: 'k5' },
      data: { createdAt: new Date(Date.now() - 30_000) },
    });
    const retry = await failure(claim('k5'));
    expect(retry.code).toBe(TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT);
  });

  /** Two contenders for one abandoned claim: exactly one takes it. */
  it('gives an abandoned claim to exactly one of two simultaneous retries', async () => {
    await claim('k6');
    await prisma.idempotencyKey.updateMany({
      where: { scope: SCOPE, key: 'k6' },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });
    const outcomes = await Promise.allSettled([claim('k6'), claim('k6')]);
    const fresh = outcomes.filter((o) => o.status === 'fulfilled').length;
    const refused = outcomes.filter((o) => o.status === 'rejected').length;
    expect(fresh).toBe(1);
    expect(refused).toBe(1);
  });

  it('abandoning releases a claim that committed nothing, and keeps one that did', async () => {
    const nothing = await claim('k7');
    if (nothing.kind !== 'fresh') throw new Error('expected fresh');
    await nothing.abandon();
    expect(await prisma.idempotencyKey.count({ where: { scope: SCOPE, key: 'k7' } })).toBe(0);

    const committed = await claim('k8');
    if (committed.kind !== 'fresh') throw new Error('expected fresh');
    await prisma.idempotencyKey.updateMany({
      where: { scope: SCOPE, key: 'k8' },
      data: { status: 'COMMITTED' },
    });
    await committed.abandon();
    expect((await row('k8')).status).toBe('COMMITTED');
  });

  /**
   * The whole point, end to end, with the real `PrismaService` — the one
   * whose `$transaction` marks the claim. An order is placed under a claim
   * and the process "dies" before recording the result. The claim must say
   * COMMITTED, the fill must exist once, and a retry must be refused without
   * a second fill.
   */
  describe('with the transaction hook', () => {
    let prismaService: PrismaService;
    let stack: TradingStack;

    beforeEach(async () => {
      /**
       * A plain lookup, not a `ConfigService`: Nest's `get` reads
       * `process.env` before its own object, and `DATABASE_URL` is set in this
       * process — so a real ConfigService here would connect the service under
       * test to the development database and fail on a tenant it cannot see.
       */
      const values: Record<string, unknown> = {
        DATABASE_URL: TEST_DATABASE_URL,
        DATABASE_TENANT_POOLS: 4,
        DATABASE_TRANSACTION_TIMEOUT_MS: 20_000,
        DATABASE_TRANSACTION_MAX_WAIT_MS: 10_000,
      };
      prismaService = new PrismaService({ get: (key: string) => values[key] } as never);
      service = new IdempotencyService(prismaService, config());
      await prisma.marketSession.deleteMany();
      await prisma.symbolSpec.deleteMany();
      await prisma.symbol.deleteMany();
      await seedTradingSymbols(prisma);
      stack = await buildTradingStack(prismaService as unknown as PrismaClient);
      await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    });

    afterAll(async () => {
      await prismaService?.onModuleDestroy();
    });

    it('commits the claim with the order, so a crash before the result is recorded cannot be retried into a second fill', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const order = { accountId, symbol: 'XAUUSD', side: 'BUY' as const, volume: '0.10' };

      await runInRequestScope({ requestId: 'r1', actorId: userId }, () =>
        withTenant(TENANT, async () => {
          const first = await service.claim<unknown>(SCOPE, 'crash', order);
          expect(first.kind).toBe('fresh');
          await stack.orders.openPosition(userId, order);
          // The process dies here: complete() is never called.
        }),
      );

      expect((await row('crash')).status).toBe('COMMITTED');
      expect(await prisma.execution.count({ where: { accountId } })).toBe(1);

      const retry = await failure(withTenant(TENANT, () => service.claim(SCOPE, 'crash', order)));
      expect(retry.code).toBe(TradingErrorCode.IDEMPOTENCY_RESULT_UNAVAILABLE);
      expect(await prisma.execution.count({ where: { accountId } })).toBe(1);
    });

    it('leaves the claim IN_PROGRESS when the order is refused before anything commits', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '1' });
      const order = { accountId, symbol: 'XAUUSD', side: 'BUY' as const, volume: '10' };

      await runInRequestScope({ requestId: 'r2', actorId: userId }, () =>
        withTenant(TENANT, async () => {
          const first = await service.claim<unknown>(SCOPE, 'refused', order);
          if (first.kind !== 'fresh') throw new Error('expected fresh');
          await expect(stack.orders.openPosition(userId, order)).rejects.toThrow();
          await first.abandon();
        }),
      );
      expect(await prisma.idempotencyKey.count({ where: { scope: SCOPE, key: 'refused' } })).toBe(
        0,
      );
      expect(await prisma.execution.count({ where: { accountId } })).toBe(0);
    });

    it('records the result normally when nothing crashes, and replays it', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const order = { accountId, symbol: 'XAUUSD', side: 'BUY' as const, volume: '0.10' };

      const result = await runInRequestScope({ requestId: 'r3', actorId: userId }, () =>
        withTenant(TENANT, async () => {
          const first = await service.claim<{ orderId: string }>(SCOPE, 'fine', order);
          if (first.kind !== 'fresh') throw new Error('expected fresh');
          const placed = await stack.orders.openPosition(userId, order);
          await first.complete(placed);
          return placed;
        }),
      );
      expect((await row('fine')).status).toBe('COMPLETED');
      const again = await withTenant(TENANT, () =>
        service.claim<{ orderId: string }>(SCOPE, 'fine', order),
      );
      expect(again).toEqual({
        kind: 'replayed',
        result: expect.objectContaining({ orderId: result.orderId }),
      });
      expect(await prisma.execution.count({ where: { accountId } })).toBe(1);
    });
  });
});
