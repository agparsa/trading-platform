import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { LedgerService } from '../../src/accounts/ledger.service';
import {
  PROTECTED_TABLES,
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  simulatingCorruption,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

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
     * Start from a known state, because a killed test run does not leave one.
     *
     * `resetDatabase` disables these triggers, truncates, and re-enables them
     * in a `finally`. A process killed in between — a timeout, a crash, ^C —
     * never runs that `finally`, so the next run starts with the guards off
     * and this suite fails with "trades actually refuses a TRUNCATE: promise
     * resolved undefined". That reads like the migration is broken. It isn't;
     * the schema is right and the residue is wrong, and an hour can go into
     * telling those apart. (One did.)
     *
     * So the guards go on before anything is asserted. This suite is about what
     * the schema guarantees, not about what the last run left behind.
     */
    for (const table of PROTECTED_TABLES) {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }

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

/**
 * The account ledger, which every other figure in the platform reconciles
 * against, and which could be edited.
 *
 * `docs/database.md` said "`balance_ledger` is append-only. Nothing updates or
 * deletes a row"; `docs/runbook.md` told whoever is on call not to edit it.
 * Both were accurate descriptions of the application's behaviour and neither
 * was a constraint. Measured against the live database before the fix:
 *
 *   DELETE FROM balance_ledger;         -- DELETE PERMITTED
 *   UPDATE balance_ledger SET amount=0; -- UPDATE PERMITTED
 *
 * `docs/security.md` had already answered why that is not enough, about a
 * different table: "a convention holds only for people who are following it …
 * the person the requirement exists for is the one who has reached a database
 * connection". The tell that this was an oversight rather than a decision is
 * the asymmetry — `wallet_transactions`, the *second* ledger, has refused
 * UPDATE and DELETE by trigger since the day it was created.
 *
 * Separate from the suite above because these need a row to exist: a row-level
 * trigger does not fire for a statement that matches nothing, so `DELETE FROM
 * balance_ledger` on an empty table succeeds and proves precisely nothing.
 * That subtlety is why this is written as a test and not as a one-off psql
 * check.
 */
suite('the account ledger refuses to be rewritten', () => {
  let prisma: PrismaClient;
  const ledger = new LedgerService();
  let entryId: string;
  let accountId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const created = await createAccount(prisma);
    accountId = created.accountId;
    const posted = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        accountId,
        type: 'DEPOSIT',
        amount: Money.of('100', 'USD'),
        description: 'opening',
      }),
    );
    entryId = posted.entryId;
  });

  it('accepts the entry in the first place', async () => {
    // Otherwise the two refusals below would pass against an empty table.
    const entry = await prisma.balanceLedger.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.amount.toString()).toBe('100');
  });

  it('refuses an UPDATE, however small', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE balance_ledger SET description = 'nothing to see' WHERE id = $1::uuid`,
        entryId,
      ),
      'a description is the most harmless column on the table, and editing it is still editing history',
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM balance_ledger WHERE id = $1::uuid`, entryId),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The correction that is meant to be used instead, working.
   *
   * A refusal is only half an answer: if there were no way to fix a mistake,
   * somebody would eventually reach for the trigger's off switch. `compensate`
   * writes a new entry pointing at the old one, and the old one stays exactly
   * as it was.
   */
  it('still lets a mistake be corrected the way it is supposed to be', async () => {
    const compensating = await prisma.$transaction((tx) =>
      ledger.compensate(tx, entryId, 'posted to the wrong account'),
    );
    expect(compensating.balanceAfter.toString()).toBe('0.00');

    const original = await prisma.balanceLedger.findUniqueOrThrow({ where: { id: entryId } });
    expect(original.amount.toString(), 'the original is untouched').toBe('100');

    const correction = await prisma.balanceLedger.findFirstOrThrow({
      where: { compensatesId: entryId },
    });
    expect(correction.amount.toString()).toBe('-100');
  });
});

/**
 * The trading record, which is what a trader would dispute.
 *
 * `executions` is every fill: the price they actually got, at the quote that
 * was live. `trades` is what their profit and loss is summed from —
 * `realized()` reads nothing else. Between them they are the evidence in any
 * argument about what happened to somebody's money, and that argument only
 * starts when somebody is already unhappy. A record that can be edited
 * afterwards settles nothing.
 *
 * These were the last two tables left open, and they were left open for a
 * stated reason: two tests corrupt them on purpose to prove the reconciliation
 * detectors fire. One of those tests now goes through `simulatingCorruption`,
 * which takes the guard off for one statement and puts it back in a `finally`;
 * the other turned out not to need corrupting at all.
 */
suite('the trading record refuses to be rewritten', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let tradeId: string;
  let executionId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    /**
     * Symbols are not tenant-scoped, so `resetDatabase` leaves them alone and
     * they carry whatever an earlier suite in the same run did to them —
     * `seedSymbols` upserts with `update: {}`, so it will not put a changed
     * instrument back. Run alone this suite passed; run after the others it
     * failed with "XAUUSD is not currently tradeable". `trading.test.ts` has
     * the same three lines for the same reason.
     */
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', '2000.00', '2000.50');
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });
    if (opened.positionId === null) throw new Error('the market order did not open a position');
    await stack.publishQuote('XAUUSD', '2100.00', '2100.50');
    await stack.positions.close(userId, opened.positionId, null);
    tradeId = (await prisma.trade.findFirstOrThrow({ where: { accountId } })).id;
    executionId = (await prisma.execution.findFirstOrThrow({ where: { accountId } })).id;
  });

  it('wrote a trade and its executions in the first place', () => {
    // Otherwise the refusals below would be passing against nothing.
    expect(tradeId).toBeTruthy();
    expect(executionId).toBeTruthy();
  });

  it('refuses to change a trade’s profit', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE trades SET net_pnl = 0 WHERE id = $1::uuid`, tradeId),
      'the number a trader would argue about is the number that must not move',
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete a trade', async () => {
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM trades WHERE id = $1::uuid`, tradeId),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to change the price a fill happened at', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE executions SET price = 1 WHERE id = $1::uuid`, executionId),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete a fill', async () => {
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM executions WHERE id = $1::uuid`, executionId),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The deliberate exception, working — and putting the guard back.
   *
   * The second half is the part worth testing. A helper that disabled a trigger
   * and left it off on a thrown assertion would silently unprotect the table
   * for every test that ran afterwards, and nothing would report it.
   */
  it('lets a test corrupt the record on purpose, and re-arms afterwards', async () => {
    await simulatingCorruption(prisma, ['executions'], () =>
      prisma.execution.deleteMany({ where: { id: executionId } }),
    );
    expect(await prisma.execution.count({ where: { id: executionId } })).toBe(0);

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM trades WHERE id = $1::uuid`, tradeId),
      'the guard is back on immediately after',
    ).rejects.toThrow(/append-only/);
  });

  it('re-arms even when the corruption throws', async () => {
    await expect(
      simulatingCorruption(prisma, ['trades'], () => {
        throw new Error('the assertion inside failed');
      }),
    ).rejects.toThrow('the assertion inside failed');

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM trades WHERE id = $1::uuid`, tradeId),
      'a thrown assertion must not leave the table unprotected for the rest of the run',
    ).rejects.toThrow(/append-only/);
  });
});
