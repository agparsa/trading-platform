import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { hasTestDatabase, TEST_DATABASE_URL } from '../apps/api/test/integration/harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The restore rehearsal has to compare the money.
 *
 * ## What it was comparing, and what it was not
 *
 * `restore-rehearsal.ts` compares two databases by twelve value fingerprints
 * and twenty-three row counts, and then prints *"the restored copy is identical
 * to the original"*. The schema has sixty-eight tables.
 *
 * Among the forty-five it never looked at were **`wallets`, `wallet_transactions`,
 * `payment_intents` and `withdrawal_requests`** — a customer's deposited money,
 * every movement of it, how it arrived and how it leaves. `accounts.balance`
 * and `balance_ledger` are the *trading* account; the wallet is a separate
 * ledger, and the eight reconciliation questions asked afterwards are about
 * ledgers and positions, so they did not reach it either.
 *
 * A restore that brought back every trade and dropped a cent from a wallet
 * printed that it was identical.
 *
 * ## Two checks, doing different jobs
 *
 * The rehearsal now counts **every** table, generated from `pg_tables`, so a
 * table a restore loses cannot be invisible — a count needs no knowledge of
 * what a table means, which is exactly why it can cover all of them.
 *
 * This file is the other half: it asks the database which tables hold money and
 * requires each to be fingerprinted by **value**, because a count cannot see a
 * cent. Reference and configuration tables are exempted by name in the script,
 * each with its reason, so skipping one is a decision somebody wrote down.
 */
suite('the restore rehearsal covers the money', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL as string } } });
  const script = readFileSync(join(import.meta.dirname, 'restore-rehearsal.ts'), 'utf8');

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** The exemptions the script declares, parsed from its own source. */
  const exempt = new Set(
    [...script.matchAll(/^\s{2}(\w+):\s*'/gm)]
      .map((m) => m[1] as string)
      .filter((name) => script.includes(`  ${name}: '`)),
  );

  /** Which tables a `FINGERPRINTS` entry actually reads. */
  const fingerprinted = new Set(
    [...script.matchAll(/FROM\s+(\w+)/g)].map((m) => (m[1] as string).toLowerCase()),
  );

  /**
   * The exemption list is pinned here as well as in the script.
   *
   * Found by mutation: adding `wallets` to the script's `NOT_MONEY` silenced
   * the check below and nothing failed. An escape hatch with no second opinion
   * is not an exemption, it is a way of turning the test off — and the way it
   * would actually happen is somebody hitting a red test at five o'clock and
   * taking the one-line route.
   *
   * Two files, so exempting a table is a deliberate act that arrives in review
   * with its reason attached.
   */
  const ALLOWED_EXEMPTIONS = [
    'account_settings',
    'account_snapshots',
    'broker_instrument_mappings',
    'candles',
    'price_alerts',
    'risk_limit_sets',
    'symbol_specs',
    'tenant_symbol_terms',
  ];

  it('exempts only what both this file and the script agree to exempt', () => {
    expect(
      [...exempt].sort(),
      'the script exempts a table this file does not — exempting one takes both',
    ).toEqual([...ALLOWED_EXEMPTIONS].sort());
  });

  it('fingerprints every table that holds an amount of somebody’s money', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'
        ORDER BY table_name`,
    );

    const uncovered = rows
      .map((row) => row.table_name)
      .filter((name) => !exempt.has(name) && !fingerprinted.has(name));

    expect(
      uncovered,
      'a table with money in it that no fingerprint reads is a table a restore can lose a cent from silently',
    ).toEqual([]);
  });

  /**
   * And the exemptions have to be real tables. A name that no longer exists is
   * a reason nobody can check, and the next reader assumes it was deliberate.
   */
  it('exempts only tables that exist', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = new Set(rows.map((row) => row.tablename));
    expect([...exempt].filter((name) => !present.has(name))).toEqual([]);
  });

  it('sweeps every table by count, not only the ones somebody listed', () => {
    expect(
      /FROM pg_tables WHERE schemaname = 'public'/.test(script),
      'the rehearsal counts only a hand-written list, so a lost table is invisible',
    ).toBe(true);
  });

  it('reads a plausible schema, so a broken query cannot pass this file', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(50);
    expect(fingerprinted.size).toBeGreaterThan(10);
  });
});
