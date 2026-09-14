import { PrismaClient } from '@prisma/client';
import { enterTenantScope, tenantScopeExtension, withTenant } from '@tp/tenancy';
import { seedTenantRoles } from '../../../../prisma/roles';

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
 * The database this suite is allowed to empty.
 *
 * `resetDatabase` truncates every table. The file header has always said this
 * must never point at a database anyone cares about — and said it to a reader,
 * which is not the same as enforcing it. One typo in `.env`, or a shell that
 * still has a production `TEST_DATABASE_URL` exported from an earlier session,
 * and the suite would empty a real database and pass while doing it.
 *
 * So the name must end in `_test`. That is a convention the tooling already
 * follows — `prepare-test-db.ts` derives the name by appending it — which makes
 * this a guard rather than a new rule to remember.
 */
export function assertDisposable(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '').split('?')[0] ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run the integration suite against database ${JSON.stringify(name)}: ` +
        'these tests TRUNCATE every table, so the name must end in `_test`. ' +
        'Run `pnpm db:test:prepare`, which creates one and prints the line for .env.',
    );
  }
  return url;
}

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
    datasources: { db: { url: assertDisposable(TEST_DATABASE_URL as string) } },
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
  kind: 'PLATFORM' | 'BROKER' = 'BROKER',
): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name: slug,
      kind,
      ...(primaryHost === undefined ? {} : { primaryHost }),
    },
  });
  /**
   * Roles too, because every permission check reads them now. A tenant created
   * without them falls back to the compile-time grants and logs an error on
   * every request — behaviour that is right in production and would make these
   * tests prove something other than what they claim.
   *
   * Inside the new tenant's own scope, because `Role` is tenant-scoped and the
   * caller is standing in a different tenant.
   */
  await withTenant({ tenantId: tenant.id, slug: tenant.slug, kind }, () =>
    seedTenantRoles(prisma, tenant.id, kind),
  );
  return tenant.id;
}

/**
 * The tables whose rows are meant to outlive everything, listed once.
 *
 * `append-only-tables.test.ts` checks this list against the database — a table
 * given a no-delete trigger and left out of here would make the reset fail on
 * whichever suite ran first, which is a confusing way to find out. It is the
 * check that told me to add the five at the top of this list, rather than a
 * hundred unrelated tests failing with a trigger error.
 *
 * That the *account ledger* had to be added in September, and the wallet ledger
 * below it never did, is the whole of the defect the append-only migration
 * fixes: the second ledger was protected at the database from the day it was
 * written, and the first one — the record of every movement of customer money —
 * was protected only by everybody agreeing not to touch it.
 */
export const PROTECTED_TABLES = [
  'balance_ledger',
  'trades',
  'executions',
  'order_events',
  'position_events',
  'risk_events',
  'integrity_signal_events',
  'audit_logs',
  'security_events',
  'broker_inbound_events',
  'api_keys',
  'service_tokens',
  'broker_credentials',
  'kyc_documents',
  'payment_events',
  'resolution_records',
  'wallet_transactions',
  'withdrawal_requests',
] as const;

/**
 * Break an append-only guarantee on purpose, for the length of one statement.
 *
 * A handful of tests exist to prove that a detector notices corruption — "a
 * filled order whose execution never happened" cannot be produced by asking
 * the service for it, because the service is what makes the two agree. The
 * only way to write that test is to corrupt the data, and the tables involved
 * now refuse to be corrupted.
 *
 * So this is the deliberate exception, in one place, with three properties
 * that matter more than the convenience:
 *
 *  - **It is loud.** The call site reads `simulatingCorruption`, so nobody
 *    reaches for it without noticing what they are doing, and a reviewer
 *    grepping for it finds every instance.
 *  - **It always puts the guard back**, in a `finally`, so a failing assertion
 *    cannot leave a table unprotected for every test that follows.
 *  - **It needs ownership of the table**, exactly as an attacker would.
 *
 * Use it only where the corruption *is* the subject of the test. If you are
 * reaching for it to set up a scenario — a trade in the past, a stale row —
 * build the scenario forward instead; there is almost always a seam. The
 * `separates today from the account lifetime` test in `account-figures.test.ts`
 * was rewritten that way rather than brought here, and is better for it.
 */
export async function simulatingCorruption<T>(
  prisma: PrismaClient,
  tables: readonly string[],
  corrupt: () => Promise<T>,
): Promise<T> {
  for (const table of tables) {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  }
  try {
    return await corrupt();
  } finally {
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
  }
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
   * Every table that refuses to be emptied, unlocked for the length of one
   * reset.
   *
   * These tables refuse UPDATE, DELETE *and* TRUNCATE by trigger. Emptying one
   * between runs therefore takes an explicit, privileged act rather than an
   * ordinary statement, and that is the point: the loop below is precisely the
   * work an attacker would have to do, and it needs ownership of each table to
   * do it.
   *
   * Written out rather than hidden behind a helper so that anybody reading the
   * harness sees what these guarantees actually cost to break. The list grew
   * from three to ten when `truncate_is_a_deletion_too` closed the back door on
   * the seven tables that refused DELETE and allowed TRUNCATE — which is the
   * clearest evidence the migration did something: before it, the reset did not
   * need to name them.
   */
  for (const table of PROTECTED_TABLES) {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  }
  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        tenants,
        integrity_signal_events, integrity_signals,
        master_account_links, master_accounts,
        broker_inbound_events, outbox_events, broker_instrument_mappings,
        broker_credentials, broker_connections,
        audit_logs, security_events, risk_events, account_snapshots, balance_ledger,
        trades, executions, position_events, positions,
        order_events, orders, account_settings,
        reconciliation_findings, reconciliation_runs,
        push_deliveries, devices, notification_preferences, notification_settings, notifications,
        accounts,
        system_settings,
        invite_redemptions, invite_codes,
        role_permissions, roles,
        totp_recovery_codes, refresh_tokens, users, idempotency_keys,
        -- Neither of these has a route back to a tenant, so the cascade above
        -- never reaches them. A leaked leader lease is the worse of the two: a
        -- lease held by a previous suite's instance id is a loop that believes
        -- somebody else is leader, in a suite that has no other instance.
        scheduled_job_runs, leader_leases
      RESTART IDENTITY CASCADE
    `);
  } finally {
    for (const table of PROTECTED_TABLES) {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
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
    data: {
      id: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
      name: 'Test Tenant',
      kind: 'PLATFORM',
    },
  });
  enterTenantScope({ tenantId: tenant.id, slug: tenant.slug, kind: 'PLATFORM' });
  /**
   * Roles are rows now, and the truncation above took them with the tenant.
   *
   * After `enterTenantScope`, not before: `Role` is a tenant-scoped model, so
   * seeding it without a scope is refused by the Prisma extension — which is the
   * extension doing its job, and cost twenty-one failing tests to remember.
   */
  await seedTenantRoles(prisma, tenant.id);
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
