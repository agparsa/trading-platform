import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PROTECTED_TABLES, createTestClient, hasTestDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * A table that refuses deletion must refuse TRUNCATE, because TRUNCATE is a
 * deletion.
 *
 * ## What was open, and for how long
 *
 * `audit_log_append_only` worked this out in August and left the reasoning in a
 * comment that is still in the migration:
 *
 *   "TRUNCATE does not fire row-level triggers, so without this it would be the
 *    one statement that empties the table while UPDATE and DELETE are refused —
 *    an unlocked back door beside two locked front ones."
 *
 * It was applied to `audit_logs`, then to `security_events`, and then to
 * nothing. Nine more tables were given a `BEFORE DELETE ... FOR EACH ROW`
 * trigger over the following fortnight and every one of them got the locked
 * front door and the open back one. Reproduced before the fix:
 *
 *   DELETE FROM withdrawal_requests;    -- ERROR: ... never deleted
 *   TRUNCATE TABLE withdrawal_requests; -- 0 rows remain, no error
 *
 * Credentials, KYC documents, venue evidence, payment events, wallet
 * transactions, withdrawals, resolution records: every table in this repository
 * whose entire purpose is that its rows survive.
 *
 * ## Why a check and not just the migration
 *
 * The migration closes the nine. It does nothing about the tenth, which will be
 * added by somebody who copies an existing append-only migration — and every
 * existing one except two would have taught them the wrong pattern. So the rule
 * is enforced against the live database: a no-delete trigger without a
 * no-truncate trigger fails this test, whichever table it is on and whenever it
 * arrives.
 */
suite('tables that refuse deletion', () => {
  let prisma: PrismaClient;

  interface Guard {
    readonly table: string;
    readonly refusesDelete: boolean;
    readonly refusesTruncate: boolean;
  }

  let guards: Guard[];

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    /**
     * Read from `pg_trigger` rather than from the migration files: what matters
     * is the state of the database production will have, and a migration that
     * was written and then superseded proves nothing about it.
     *
     * `tgtype` is a bitmask — 8 is DELETE, 32 is TRUNCATE.
     */
    guards = await prisma.$queryRawUnsafe<Guard[]>(`
      SELECT c.relname AS "table",
             bool_or(t.tgtype & 8  > 0) AS "refusesDelete",
             bool_or(t.tgtype & 32 > 0) AS "refusesTruncate"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
      GROUP BY c.relname
      HAVING bool_or(t.tgtype & 8 > 0)
      ORDER BY c.relname
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('found the triggers at all', () => {
    // The failure mode of every check that reads a catalogue.
    expect(guards.length).toBeGreaterThanOrEqual(11);
    expect(guards.map((g) => g.table)).toContain('audit_logs');
  });

  it('refuse TRUNCATE as well, on every one of them', () => {
    const open = guards.filter((g) => !g.refusesTruncate).map((g) => g.table);
    expect(
      open,
      `These tables refuse DELETE and allow TRUNCATE:\n` +
        open.map((t) => `  ${t}`).join('\n') +
        `\n\nTRUNCATE does not fire row-level triggers, so it empties the table while ` +
        `DELETE is refused — an unlocked back door beside a locked front one. Add a ` +
        `BEFORE TRUNCATE ... FOR EACH STATEMENT trigger using the same refusal function, ` +
        `as 20260913093000_truncate_is_a_deletion_too does, and add the table to ` +
        `PROTECTED_TABLES in both test harnesses.`,
    ).toEqual([]);
  });

  /**
   * The harness has to know about every one of them, or the first suite to run
   * dies inside `resetDatabase` with a trigger error and no clue which table.
   */
  it('are all named in the harness, and the harness names nothing extra', () => {
    const protectedTables = [...PROTECTED_TABLES].sort();
    expect(guards.map((g) => g.table).sort()).toEqual(protectedTables);
  });

  /**
   * The catalogue says a trigger exists. This says it fires.
   *
   * Worth separating: a trigger can be present and disabled — which is exactly
   * what `resetDatabase` does to these tables, deliberately, and what an
   * attacker with table ownership would do too.
   */
  it.each([...PROTECTED_TABLES])('%s actually refuses a TRUNCATE', async (table) => {
    const attempt = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${table}`);
    });
    await expect(attempt, `TRUNCATE TABLE ${table} was permitted`).rejects.toThrow();
  });
});
