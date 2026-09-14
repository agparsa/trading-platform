import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { assertDisposable, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The integration suite truncates every table it can reach. Everything else in
 * this directory tests the platform; this tests the blast radius.
 */
describe('the database the integration suite is allowed to empty', () => {
  it.each([
    'postgresql://u:p@localhost:5432/trading_platform_test',
    'postgresql://u:p@localhost:5432/trading_platform_test?schema=public',
    'postgresql://u@db:5432/anything_test?schema=public&connection_limit=5',
  ])('accepts %s', (url) => {
    expect(assertDisposable(url)).toBe(url);
  });

  /**
   * The last two are the ones that matter. `trading_platform` is one keystroke
   * from the name that is allowed, and a `_test` that is not at the end is what
   * a copied connection string looks like after somebody edited the host.
   */
  it.each([
    ['the production database', 'postgresql://u:p@prod:5432/trading_platform'],
    ['a database with no name', 'postgresql://u:p@prod:5432/'],
    ['_test in the middle', 'postgresql://u:p@prod:5432/trading_test_platform'],
    ['_test as the host, not the database', 'postgresql://u:p@db_test:5432/trading_platform'],
    ['_test only in a query parameter', 'postgresql://u:p@prod:5432/trading?schema=public_test'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertDisposable(url)).toThrow(/must end in `_test`/);
  });
});

/**
 * The reset has to actually reset.
 *
 * `resetDatabase` empties the database by naming tables in a `TRUNCATE ...
 * CASCADE`, and most tenant-scoped tables are reached through the cascade from
 * `tenants` rather than by name. A table with no route back to a tenant is
 * reached by neither, and nothing said so: `scheduled_job_runs` was added, the
 * list was not, and rows leaked from one test into the next. The symptom was
 * two tests that passed alone and failed together — an order-dependent failure,
 * which is the most expensive kind to chase and the easiest to blame on
 * anything but the harness.
 *
 * A hand-written list is an assumption with an expiry date, and this repository
 * has now watched three of them expire. So the list is checked against the
 * database rather than against somebody's memory: after a reset, every table is
 * empty except the ones named below, each with the reason it survives.
 */
suite('the test harness', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Tables a reset deliberately leaves alone, and why.
   *
   * Each of these is either the migration ledger, a seeded reference table that
   * every suite expects to find populated, or a row the reset itself writes.
   * Anything not on this list and not empty is a leak.
   */
  const KEPT: Record<string, string> = {
    _prisma_migrations: 'the migration ledger; truncating it would re-run every migration',
    symbols: 'reference data seeded once per database, not per test',
    symbol_specs: 'reference data seeded once per database, not per test',
    market_sessions: 'reference data seeded once per database, not per test',
    tenants: 'the reset writes the default tenant back after emptying',
    roles: 'the reset seeds the role and permission rows every suite signs in against',
    role_permissions: 'seeded with the roles, for the same reason',
    system_settings: 'seeded defaults the API reads on the first request',
  };

  it('leaves no rows behind in any table it does not deliberately keep', async () => {
    await resetDatabase(prisma);

    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );

    const leaked: string[] = [];
    for (const { tablename } of tables) {
      if (tablename in KEPT) continue;
      const counted = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM "${tablename}"`,
      );
      const count = Number(counted[0]?.count ?? 0);
      if (count > 0) leaked.push(`${tablename} (${String(count)} rows)`);
    }

    expect(
      leaked,
      'a table the reset does not reach leaks rows between tests, and the failure looks like anything but the harness',
    ).toEqual([]);
  });

  /**
   * And the other direction: a name on the keep-list that no longer exists is a
   * reason nobody can check, and the next reader assumes it was deliberate.
   */
  it('keeps no table that is no longer there', async () => {
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = new Set(tables.map((one) => one.tablename));
    expect(Object.keys(KEPT).filter((name) => !present.has(name))).toEqual([]);
  });
});
