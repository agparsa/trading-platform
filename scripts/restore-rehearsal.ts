#!/usr/bin/env tsx
/**
 * The restore rehearsal.
 *
 * A backup nobody has restored is a hypothesis. §71 asks for the rehearsal, and
 * the rehearsal is the only thing that turns "we take nightly dumps" into a
 * statement about the business: *if the database is lost at 14:00, this is what
 * we get back and this is how long it takes.*
 *
 * So this does the whole thing, end to end, against the real database:
 *
 *   1. Dump it, timed.
 *   2. Create an empty database next to it.
 *   3. Restore into that, timed.
 *   4. Run `prisma migrate deploy` against the restored copy, and require it to
 *      find **nothing to do** — a restore that needs migrating is a restore of a
 *      schema that was already behind.
 *   5. Compare the two, account by account.
 *   6. Run the real reconciliation engine over the restored copy.
 *   7. Report how long the whole thing took.
 *
 * ## Why counts are not the check
 *
 * The obvious rehearsal compares row counts and declares victory. A restore that
 * has every row and one account a cent short is a restore that has lost money,
 * and it passes that test.
 *
 * So the comparison is over **values**: every account's balance, every account's
 * ledger sum, and a checksum over the identifying and monetary columns of every
 * order, position and trade. Two databases that agree on all of that agree in the
 * way that matters.
 *
 * ## Why reconciliation runs on the copy
 *
 * The question is not "did the bytes copy". It is "is the restored system
 * self-consistent" — do balances still equal their ledgers, do positions still
 * have the executions that opened them, does realized P&L still add up. That is
 * exactly what the reconciliation engine already answers, and asking it here
 * reuses the definition rather than writing a second one.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { ReconciliationService } from '../apps/worker/src/jobs/reconciliation.service';
// The worker's PrismaService, because ReconciliationService is the worker's.
// This pointed at the API's, which is a structurally different class — the cast
// below silenced it, and the two would have drifted apart unnoticed.
import type { PrismaService } from '../apps/worker/src/prisma.service';

const run = promisify(execFile);

const SOURCE_URL = process.env['DATABASE_URL'] ?? '';
const RESTORE_DB = process.env['RESTORE_DB_NAME'] ?? 'trading_platform_restore_rehearsal';
const KEEP = process.env['KEEP_RESTORE'] === '1';

interface Timing {
  label: string;
  seconds: number;
  detail?: string;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<[T, Timing]> {
  const began = Date.now();
  const result = await work();
  return [result, { label, seconds: (Date.now() - began) / 1000 }];
}

/** Splits a Prisma URL into the pieces the command-line tools want. */
function parseUrl(url: string): {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string | null;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    user: decodeURIComponent(parsed.username),
    database: parsed.pathname.replace(/^\//, ''),
    password: parsed.password === '' ? null : decodeURIComponent(parsed.password),
  };
}

function urlFor(source: string, database: string): string {
  const parsed = new URL(source);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * What "the same database" means here.
 *
 * Balances and ledger sums per account, plus a checksum over every order,
 * position and trade. `md5` of an ordered aggregate is enough: this is comparing
 * two copies of the same data, not defending against a forger.
 */
const FINGERPRINTS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: 'accounts (id, number, balance, currency, status)',
    sql: `SELECT md5(string_agg(id::text || number || balance::text || currency || status, '|' ORDER BY id)) AS f FROM accounts`,
  },
  {
    name: 'balance_ledger (per-account sums)',
    sql: `SELECT md5(string_agg(account_id::text || total, '|' ORDER BY account_id)) AS f
            FROM (SELECT account_id, SUM(amount)::text AS total FROM balance_ledger GROUP BY account_id) t`,
  },
  {
    name: 'orders (id, status, volume, price)',
    sql: `SELECT md5(string_agg(id::text || status || volume::text || COALESCE(price::text, ''), '|' ORDER BY id)) AS f FROM orders`,
  },
  {
    name: 'positions (id, status, volume, entry, realized)',
    sql: `SELECT md5(string_agg(id::text || status || volume::text || entry_price::text || COALESCE(realized_pnl::text, ''), '|' ORDER BY id)) AS f FROM positions`,
  },
  {
    name: 'trades (id, net p&l, commission, swap)',
    sql: `SELECT md5(string_agg(id::text || net_pnl::text || commission::text || swap::text, '|' ORDER BY id)) AS f FROM trades`,
  },
  {
    name: 'executions (id, price, volume)',
    sql: `SELECT md5(string_agg(id::text || price::text || volume::text, '|' ORDER BY id)) AS f FROM executions`,
  },
  {
    name: 'users (id, email, role)',
    sql: `SELECT md5(string_agg(id::text || email || role::text, '|' ORDER BY id)) AS f FROM users`,
  },
  {
    name: 'audit_logs (id, action, resource)',
    sql: `SELECT md5(string_agg(id::text || action || resource_type, '|' ORDER BY id)) AS f FROM audit_logs`,
  },
  /**
   * The evidence tables.
   *
   * A restore that brought back the money and lost the record of *what somebody
   * decided about it* has lost the half that matters in a dispute. A finding
   * closed with a note, an integrity signal under review, a notice a trader was
   * sent — all of them are the answer to "what did you know and when", and none
   * of them can be recomputed from the balances.
   */
  {
    name: 'reconciliation_findings (id, code, status, occurrences)',
    sql: `SELECT md5(string_agg(id::text || code || status::text || occurrences::text, '|' ORDER BY id)) AS f FROM reconciliation_findings`,
  },
  {
    name: 'reconciliation_runs (id, status, findings)',
    sql: `SELECT md5(string_agg(id::text || status::text || findings_raised::text, '|' ORDER BY id)) AS f FROM reconciliation_runs`,
  },
  {
    name: 'integrity_signals (id, code, status, occurrences)',
    sql: `SELECT md5(string_agg(id::text || code || status::text || occurrences::text, '|' ORDER BY id)) AS f FROM integrity_signals`,
  },
  {
    name: 'notifications (id, kind, read)',
    sql: `SELECT md5(string_agg(id::text || kind || coalesce(read_at::text, '-'), '|' ORDER BY id)) AS f FROM notifications`,
  },
];

const COUNTED = [
  'users',
  'accounts',
  'balance_ledger',
  'orders',
  'order_events',
  'executions',
  'positions',
  'position_events',
  'trades',
  'audit_logs',
  'security_events',
  'risk_events',
  'account_snapshots',
  'refresh_tokens',
  'totp_recovery_codes',
  'integrity_signals',
  'integrity_signal_events',
  'reconciliation_runs',
  'reconciliation_findings',
  'notifications',
  'master_accounts',
  'master_account_links',
  'idempotency_keys',
] as const;

async function fingerprint(prisma: PrismaClient): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const { name, sql } of FINGERPRINTS) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ f: string | null }>>(sql);
    results.set(name, row?.f ?? '(empty)');
  }
  return results;
}

async function counts(prisma: PrismaClient): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  for (const table of COUNTED) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM ${table}`,
    );
    results.set(table, Number(row?.n ?? 0));
  }
  return results;
}

async function main(): Promise<void> {
  assert(SOURCE_URL.length > 0, 'DATABASE_URL is not set');
  const source = parseUrl(SOURCE_URL);
  assert(
    source.database !== RESTORE_DB,
    'the restore target is the source database — that is not a rehearsal, it is an outage',
  );

  const env = {
    ...process.env,
    ...(source.password === null ? {} : { PGPASSWORD: source.password }),
  };
  const connect = ['-h', source.host, '-p', source.port, '-U', source.user];
  const workspace = await mkdtemp(join(tmpdir(), 'restore-rehearsal-'));
  const dumpPath = join(workspace, 'backup.dump');
  const timings: Timing[] = [];
  const problems: string[] = [];

  const sourcePrisma = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
  let restoredPrisma: PrismaClient | null = null;

  try {
    console.log(`\n  Rehearsing a restore of "${source.database}" into "${RESTORE_DB}".\n`);

    // --- 1. dump ----------------------------------------------------------
    const [, dumpTiming] = await timed('dump', async () => {
      // Custom format: it is what a real backup uses, it compresses, and it can
      // be restored in parallel. A plain SQL dump would rehearse a procedure
      // nobody runs.
      await run('pg_dump', [...connect, '-Fc', '-f', dumpPath, source.database], { env });
    });
    const dumpBytes = (await stat(dumpPath)).size;
    dumpTiming.detail = `${(dumpBytes / 1024 / 1024).toFixed(1)}MB`;
    timings.push(dumpTiming);

    // --- 2. an empty database --------------------------------------------
    await run('dropdb', [...connect, '--if-exists', RESTORE_DB], { env }).catch(() => undefined);
    await run('createdb', [...connect, RESTORE_DB], { env });

    // --- 3. restore -------------------------------------------------------
    const [, restoreTiming] = await timed('restore', async () => {
      try {
        await run(
          'pg_restore',
          [...connect, '-d', RESTORE_DB, '--no-owner', '--no-privileges', dumpPath],
          { env, maxBuffer: 32 * 1024 * 1024 },
        );
      } catch (error) {
        // pg_restore exits non-zero on warnings it has already recovered from.
        // What decides success is the comparison below, not the exit code — but
        // the output is kept so a real failure is not silently accepted.
        const detail = (error as { stderr?: string }).stderr ?? String(error);
        if (!/errors ignored on restore/i.test(detail)) throw new Error(detail.slice(0, 2000));
        problems.push(`pg_restore reported recoverable errors: ${detail.slice(0, 300)}`);
      }
    });
    timings.push(restoreTiming);

    const restoredUrl = urlFor(SOURCE_URL, RESTORE_DB);
    restoredPrisma = new PrismaClient({ datasources: { db: { url: restoredUrl } } });

    // --- 4. migrations ----------------------------------------------------
    const [migrateOutput, migrateTiming] = await timed('migrate deploy', async () => {
      const { stdout } = await run('npx', ['prisma', 'migrate', 'deploy'], {
        env: { ...env, DATABASE_URL: restoredUrl },
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    });
    timings.push(migrateTiming);

    /**
     * A restore that needs migrating is a restore of a schema that was already
     * behind — which means the backup and the code have drifted, and the moment
     * to discover that is now rather than during an incident.
     */
    if (!/No pending migrations/i.test(migrateOutput)) {
      problems.push(
        `the restored database was not at schema head: ${migrateOutput.trim().split('\n').slice(-3).join(' ')}`,
      );
    }

    // --- 5. compare -------------------------------------------------------
    console.log('  Comparing the copy with the original.\n');

    const [sourceCounts, restoredCounts] = await Promise.all([
      counts(sourcePrisma),
      counts(restoredPrisma),
    ]);
    for (const table of COUNTED) {
      const a = sourceCounts.get(table) ?? 0;
      const b = restoredCounts.get(table) ?? 0;
      const mark = a === b ? ' ' : '!';
      console.log(
        `   ${mark} ${table.padEnd(20)} ${String(a).padStart(8)} → ${String(b).padStart(8)}`,
      );
      if (a !== b) problems.push(`${table}: ${a} rows became ${b}`);
    }

    console.log('');
    const [sourcePrints, restoredPrints] = await Promise.all([
      fingerprint(sourcePrisma),
      fingerprint(restoredPrisma),
    ]);
    for (const { name } of FINGERPRINTS) {
      const a = sourcePrints.get(name);
      const b = restoredPrints.get(name);
      const same = a === b;
      console.log(`   ${same ? ' ' : '!'} ${name}`);
      if (!same) problems.push(`${name} differs between the original and the copy`);
    }

    // --- 6. is the copy self-consistent? ----------------------------------
    /**
     * The real reconciliation engine, run against the restored copy.
     *
     * Not a hand-written balance-versus-ledger query, which is what this did
     * first. That query was a *second definition* of an invariant the platform
     * already defines in one place, and the second definition was wrong: it
     * looked for executions on `position_id`, a column that does not exist,
     * because executions belong to orders. Two definitions of a financial
     * invariant is exactly the thing §80 forbids, and this is why.
     *
     * So the copy is asked the same eight questions the scheduled job asks every
     * night: ledger drift, filled orders without executions, positions without
     * opening executions, position volumes, trades without ledger entries,
     * realized P&L, commission and swap. If the restored database can answer
     * those the way the original does, it is not merely a copy of the bytes — it
     * is a system that still adds up.
     */
    console.log('\n  Reconciling the restored copy against itself.\n');
    const reconciliation = new ReconciliationService(restoredPrisma as unknown as PrismaService);
    const summary = await reconciliation.check();

    console.log(
      `   ${summary.checked} account(s) checked, ${summary.findings} finding(s), ` +
        `${summary.critical} critical.`,
    );
    if (summary.findings > 0) {
      for (const report of summary.reports.slice(0, 5)) {
        for (const found of report.findings.slice(0, 3)) {
          problems.push(`restored ${report.number}: ${found.message}`);
        }
      }
    }

    // --- 7. how long ------------------------------------------------------
    const total = timings.reduce((sum, t) => sum + t.seconds, 0);
    console.log('\n  Time to recover:\n');
    for (const timing of timings) {
      console.log(
        `   ${timing.label.padEnd(16)} ${timing.seconds.toFixed(1).padStart(7)}s` +
          (timing.detail === undefined ? '' : `   ${timing.detail}`),
      );
    }
    console.log(`   ${'total'.padEnd(16)} ${total.toFixed(1).padStart(7)}s`);
  } finally {
    await sourcePrisma.$disconnect();
    await restoredPrisma?.$disconnect();
    if (!KEEP) {
      await run('dropdb', [...connect, '--if-exists', RESTORE_DB], { env }).catch(() => undefined);
    } else {
      console.log(`\n  Kept "${RESTORE_DB}" for inspection (KEEP_RESTORE=1).`);
    }
    await rm(workspace, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('\n  The rehearsal found something:\n');
    for (const problem of problems) console.error(`    - ${problem}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  console.log(
    '\n  The restored copy is identical to the original and self-consistent.\n' +
      '  Measured on this machine, against this data volume. Both numbers change\n' +
      '  in production, and the rehearsal is what tells you by how much.\n',
  );
}

void main();
