import { PrismaClient } from '@prisma/client';
import { enterTenantScope, tenantScopeExtension } from '@tp/tenancy';

/**
 * Integration-test harness for the worker.
 *
 * A copy of the API's harness rather than a shared import: the two apps have
 * separate dependency trees, and a test helper reaching across app boundaries
 * would tie their build graphs together for no benefit.
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
 * The test client carries the tenant-scope extension, exactly as the worker's
 * does. A test client without it would exercise a different Prisma than the
 * process under test, and the difference would be the isolation itself.
 */
export function createTestClient(): PrismaClient {
  if (!hasTestDatabase) throw new Error('TEST_DATABASE_URL is not set');
  return new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
  }).$extends(tenantScopeExtension()) as unknown as PrismaClient;
}

/**
 * Empties every table the tests write to.
 *
 * Order matters only in that TRUNCATE ... CASCADE handles the foreign keys for
 * us; RESTART IDENTITY keeps sequence values from drifting between runs so a
 * failure is reproducible.
 */
/** The tenant every worker test runs inside. Fixed, for the reasons in the API harness. */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-0000000000ff';
export const DEFAULT_TENANT_SLUG = 'test-tenant';

export async function resetDatabase(prisma: PrismaClient): Promise<string> {
  /**
   * `audit_logs` refuses UPDATE, DELETE and TRUNCATE — see the
   * `audit_log_append_only` migration. Emptying it between runs therefore takes
   * an explicit, privileged act rather than an ordinary statement, and the two
   * lines below are precisely the work an attacker would have to do. They need
   * ownership of the table to do it.
   */
  await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`);
  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        audit_logs, risk_events, account_snapshots, balance_ledger,
        trades, executions, position_events, positions,
        order_events, orders, account_settings,
        reconciliation_findings, reconciliation_runs,
        devices, notification_preferences, notification_settings, notifications,
        accounts,
        system_settings, tenants,
        invite_redemptions, invite_codes,
        totp_recovery_codes, refresh_tokens, users, idempotency_keys
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`);
  }

  const tenant = await prisma.tenant.create({
    data: { id: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, name: 'Test Tenant' },
  });
  // `enterWith` rather than `withTenant`, because a `beforeEach` cannot wrap the
  // test body. See the API harness for the full note.
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
/** A second tenant, for tests that need the boundary rather than the default. */
export async function createTenant(prisma: PrismaClient, slug: string): Promise<string> {
  const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
  return tenant.id;
}

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
