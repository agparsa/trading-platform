import { PrismaClient } from '@prisma/client';
import { enterTenantScope, tenantScopeExtension } from '@tp/tenancy';

/**
 * Integration-test harness.
 *
 * These tests run against a real PostgreSQL database, because the behaviour
 * being checked — row locks, unique constraints, transaction boundaries — does
 * not exist in a mock. A mocked `FOR UPDATE` proves nothing.
 *
 * They skip themselves when `TEST_DATABASE_URL` is unset so that `pnpm test`
 * still runs on a machine with no database. CI always sets it.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const hasTestDatabase =
  typeof TEST_DATABASE_URL === 'string' && TEST_DATABASE_URL.length > 0;

/**
 * The test client carries the tenant-scope extension, exactly as the
 * application's does.
 *
 * A test client without it would exercise a different Prisma than production
 * runs — and the difference would be precisely the isolation these tests exist
 * to check. The cast keeps `PrismaClient` as the type the tests see; the
 * extension is transparent to every call that is correctly scoped.
 */
export function createTestClient(): PrismaClient {
  if (!hasTestDatabase) throw new Error('TEST_DATABASE_URL is not set');
  return new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
  }).$extends(tenantScopeExtension()) as unknown as PrismaClient;
}

/** The tenant every test runs inside unless it says otherwise. */
export const DEFAULT_TENANT_SLUG = 'test-tenant';

/**
 * A fixed id, not a generated one.
 *
 * `resetDatabase` truncates and recreates the tenant between every test, and
 * `AsyncLocalStorage.enterWith` set once in a `beforeEach` does not reliably
 * re-take on the second and subsequent hooks — the store from the first test
 * persists. With a generated id that means test two writes rows referencing a
 * tenant test one deleted, and the failure is a foreign-key violation a long
 * way from its cause.
 *
 * A stable id makes the stale scope correct rather than merely tolerated, and
 * makes a failing test reproducible in the bargain.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Creates a tenant and returns its id. Not scoped — `Tenant` has no tenant.
 */
export async function createTenant(
  prisma: PrismaClient,
  slug: string,
  primaryHost?: string,
): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name: slug,
      ...(primaryHost === undefined ? {} : { primaryHost }),
    },
  });
  return tenant.id;
}

/**
 * Empties every table the tests write to.
 *
 * Order matters only in that TRUNCATE ... CASCADE handles the foreign keys for
 * us; RESTART IDENTITY keeps sequence values from drifting between runs so a
 * failure is reproducible.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<string> {
  /**
   * `audit_logs` refuses UPDATE, DELETE and TRUNCATE — see the
   * `audit_log_append_only` migration. Emptying it between runs therefore takes
   * an explicit, privileged act rather than an ordinary statement, and that is
   * the point: the two lines below are precisely the work an attacker would
   * have to do, and they need ownership of the table to do it.
   *
   * Written out here rather than hidden behind a helper so that anybody reading
   * the harness sees what the audit log's guarantee actually costs to break.
   */
  await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`);
  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        tenants,
        integrity_signal_events, integrity_signals,
        master_account_links, master_accounts,
        audit_logs, risk_events, account_snapshots, balance_ledger,
        trades, executions, position_events, positions,
        order_events, orders, account_settings,
        reconciliation_findings, reconciliation_runs, notifications, accounts,
        system_settings,
        invite_redemptions, invite_codes,
        totp_recovery_codes, refresh_tokens, users, idempotency_keys
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`);
  }

  /**
   * Every test runs inside a tenant, because every request does.
   *
   * `enterWith` rather than `withTenant` because a `beforeEach` cannot wrap the
   * test body — see tenancy/tenant-context.ts. It propagates from the hook into
   * the test, which is checked rather than assumed: without it, the first
   * `prisma.user.create` in any suite throws "no tenant in scope".
   *
   * `Tenant` is not a tenant-scoped model, so this create needs no scope of its
   * own. That matters more than it looks: wrapping it in `withoutTenantScope`
   * — which uses `AsyncLocalStorage.run` — made the `enterWith` immediately
   * after it silently do nothing, and every suite failed with "no tenant in
   * scope" while the line that set it sat right there in the source.
   */
  const tenant = await prisma.tenant.create({
    data: { id: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, name: 'Test Tenant' },
  });
  enterTenantScope({ tenantId: tenant.id, slug: tenant.slug });
  return tenant.id;
}

export async function seedSymbols(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'XAUUSD' },
    create: {
      code: 'XAUUSD',
      description: 'Gold vs US Dollar',
      category: 'Metals',
      quoteCurrency: 'USD',
    },
    update: {},
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100',
      tickSize: '0.01',
      pricePrecision: 2,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '100',
      marginRate: '0.01',
      commissionPerLot: '0',
      swapLongPerLot: '-12.5',
      swapShortPerLot: '4.75',
    },
    update: {},
  });
}

/** Creates a user and one funded account directly, bypassing the HTTP layer. */
export async function createAccount(
  prisma: PrismaClient,
  options: { balance?: string; currency?: string; email?: string; tenantId?: string } = {},
): Promise<{ userId: string; accountId: string; currency: string }> {
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const currency = options.currency ?? 'USD';
  const suffix = Math.floor(Number(process.hrtime.bigint() % 1_000_000_000n));
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: options.email ?? `trader-${suffix}@test.local`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Test Trader',
    },
  });
  const numbers = await prisma.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('account_number_seq') AS value
  `;
  const account = await prisma.account.create({
    data: {
      userId: user.id,
      number: `TP-${numbers[0]?.value.toString() ?? '0'}`,
      type: 'DEMO',
      currency,
      balance: '0',
      tenantId,
      settings: { create: { tenantId } },
    },
  });
  if (options.balance !== undefined) {
    await prisma.balanceLedger.create({
      data: {
        tenantId,
        accountId: account.id,
        type: 'DEPOSIT',
        amount: options.balance,
        balanceAfter: options.balance,
        currency,
        description: 'test opening balance',
      },
    });
    await prisma.account.update({
      where: { id: account.id },
      data: { balance: options.balance },
    });
  }
  return { userId: user.id, accountId: account.id, currency };
}

/**
 * Seeds XAUUSD with a round-the-clock session.
 *
 * Trading tests must not depend on what day it is. The real XAUUSD session
 * closes at weekends, which would make the whole suite fail every Saturday —
 * so the session calendar is tested directly (see market/session.test.ts) and
 * neutralised here.
 */
export async function seedTradingSymbols(prisma: PrismaClient): Promise<void> {
  await seedSymbols(prisma);
  const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
  await prisma.marketSession.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      symbolId: symbol.id,
      timezone: 'UTC',
      dayOfWeek,
      openMinute: 0,
      closeMinute: 1440,
    })),
  });
}

/** Seeds an instrument whose session never opens, for the market-closed case. */
export async function seedClosedSymbol(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'CLOSEDX' },
    create: {
      code: 'CLOSEDX',
      description: 'Permanently closed instrument',
      category: 'Test',
      quoteCurrency: 'USD',
    },
    update: {},
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100',
      tickSize: '0.01',
      pricePrecision: 2,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '100',
      marginRate: '0.01',
      commissionPerLot: '0',
      swapLongPerLot: '0',
      swapShortPerLot: '0',
    },
    update: {},
  });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
}

/**
 * An instrument quoted in a currency that is not the account's.
 *
 * USDJPY is the platform's first such instrument, and it exists for exactly
 * this reason: every other listed contract settles its P&L in USD, so the whole
 * conversion path — `ConversionService`, and the `quoteToAccountRate` that
 * multiplies P&L, margin and exposure on every foreign-quoted position — was
 * reachable in production and exercised by nothing.
 *
 * Its session is open every minute of the week so a test does not depend on
 * which day it runs.
 */
export async function seedJpySymbol(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'USDJPY' },
    create: {
      code: 'USDJPY',
      description: 'US Dollar vs Japanese Yen',
      category: 'FX',
      quoteCurrency: 'JPY',
    },
    update: { quoteCurrency: 'JPY' },
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100000',
      tickSize: '0.001',
      pricePrecision: 3,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '200',
      marginRate: '0.002',
      commissionPerLot: '3.5',
      swapLongPerLot: '1.8',
      swapShortPerLot: '-3.2',
    },
    update: {},
  });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
  await prisma.marketSession.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      symbolId: symbol.id,
      timezone: 'UTC',
      dayOfWeek,
      openMinute: 0,
      closeMinute: 1440,
    })),
  });
}
