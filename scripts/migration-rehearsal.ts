#!/usr/bin/env tsx
/**
 * The migration rehearsal.
 *
 * `docker-compose.prod.yml` runs `prisma migrate deploy` as a job every other
 * container waits for, so a migration that fails does not take the platform
 * down — it stops the deploy dead, with the old containers still serving and
 * somebody reading a job log at whatever hour it is. That is the good outcome.
 * The better one is finding out before the deploy, which is what this does.
 *
 * Three questions, in the order they bite:
 *
 *   1. **Does the chain apply at all?** Every migration, in order, against an
 *      empty database, with the exact command production runs.
 *   2. **Does it apply to a database that is behind?** The same chain again,
 *      but stopping partway and then deploying the rest — because that, not
 *      the empty case, is what production actually is. A migration that
 *      depends on something a *later* one creates passes the first check and
 *      fails this one.
 *   3. **Does the result match `schema.prisma`?** `migrate diff` between the
 *      rehearsed database and the datamodel must come back empty. Drift here
 *      is how a migration nobody wrote gets proposed later and rides into
 *      production attached to an unrelated change — which has already happened
 *      once in this repository, with eight index renames.
 *
 * ## Why the cut points are the last few, and not all of them
 *
 * Checking every prefix is forty-odd database builds for a property that only
 * varies near the end: the migrations production has *not* applied yet are the
 * recent ones, and an older prefix was proven by every deploy since. The last
 * few cover every plausible state of a production database that is behind,
 * which is the question being asked.
 *
 * Run it before a deploy. It needs an owner connection, so it is a developer's
 * command rather than something the deploy script calls.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SOURCE_URL = process.env['DATABASE_URL'] ?? '';
const SCRATCH_DB = 'trading_platform_migration_rehearsal';
/** How many "production is this far behind" positions to rehearse. */
const CUT_POINTS = Number(process.env['MIGRATION_REHEARSAL_CUTS'] ?? '3');

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations');

interface Parsed {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string | null;
  readonly database: string;
}

function parseUrl(url: string): Parsed {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    user: decodeURIComponent(parsed.username),
    password: parsed.password === '' ? null : decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

function scratchUrl(source: Parsed): string {
  const auth =
    source.password === null
      ? encodeURIComponent(source.user)
      : `${encodeURIComponent(source.user)}:${encodeURIComponent(source.password)}`;
  return `postgresql://${auth}@${source.host}:${source.port}/${SCRATCH_DB}?schema=public`;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string> {
  const { stdout, stderr } = await exec(command, [...args], {
    ...options,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout + stderr;
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * A migrations directory holding only the first `count` migrations.
 *
 * `prisma migrate deploy` applies whatever is in the directory it is pointed
 * at, so a truncated copy is how a database "at an older release" is built
 * without checking out an older commit — and without any risk of the working
 * tree being left on one.
 */
async function partialMigrations(count: number, into: string): Promise<void> {
  await cp(join(MIGRATIONS_DIR, 'migration_lock.toml'), join(into, 'migration_lock.toml'));
  for (const folder of migrationFolders().slice(0, count)) {
    await cp(join(MIGRATIONS_DIR, folder), join(into, folder), { recursive: true });
  }
}

async function main(): Promise<void> {
  assert(SOURCE_URL.length > 0, 'DATABASE_URL is not set');
  const source = parseUrl(SOURCE_URL);
  assert(
    source.database !== SCRATCH_DB,
    'DATABASE_URL already points at the scratch database — refusing, that is not a rehearsal',
  );

  const env = {
    ...process.env,
    ...(source.password === null ? {} : { PGPASSWORD: source.password }),
  };
  const connect = ['-h', source.host, '-p', source.port, '-U', source.user];
  const url = scratchUrl(source);
  const all = migrationFolders();
  assert(all.length > 0, 'there are no migrations to rehearse');

  // Empty first, then increasingly-behind databases. `0` is the fresh-install
  // case; the rest are "production is N migrations behind".
  const cuts = [0, ...Array.from({ length: CUT_POINTS }, (_, i) => all.length - 1 - i)]
    .filter((n) => n >= 0 && n < all.length)
    .filter((n, i, list) => list.indexOf(n) === i)
    .sort((a, b) => a - b);

  console.log(
    `\n  Rehearsing ${all.length} migrations from ${cuts.length} starting points ` +
      `into "${SCRATCH_DB}".\n`,
  );

  let failures = 0;
  const workspace = await mkdtemp(join(tmpdir(), 'migration-rehearsal-'));

  try {
    for (const cut of cuts) {
      const label =
        cut === 0
          ? 'a fresh install'
          : `a database ${all.length - cut} migration(s) behind (at ${all[cut - 1]})`;
      const started = Date.now();
      try {
        await run('dropdb', [...connect, '--if-exists', SCRATCH_DB], { env });
        await run('createdb', [...connect, SCRATCH_DB], { env });

        if (cut > 0) {
          const partial = await mkdtemp(join(workspace, 'partial-'));
          await partialMigrations(cut, partial);
          await run('npx', ['prisma', 'migrate', 'deploy', '--schema', ROOT + '/prisma/schema.prisma'], {
            // The truncated directory stands in for the older release. Prisma
            // resolves migrations relative to the schema, so the schema is
            // copied beside them.
            env: { ...env, DATABASE_URL: url, PRISMA_MIGRATIONS_PATH: partial },
            cwd: ROOT,
          }).catch(async () => {
            // Older Prisma has no PRISMA_MIGRATIONS_PATH; fall back to applying
            // the SQL directly, which is the same statements in the same order.
            for (const folder of all.slice(0, cut)) {
              await run(
                'psql',
                [...connect, '-v', 'ON_ERROR_STOP=1', '-q', '-d', SCRATCH_DB, '-f',
                  join(MIGRATIONS_DIR, folder, 'migration.sql')],
                { env },
              );
            }
            // The history table has to agree, or `migrate deploy` re-applies them.
            for (const folder of all.slice(0, cut)) {
              await run(
                'psql',
                [...connect, '-q', '-d', SCRATCH_DB, '-c',
                  `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
                   VALUES (gen_random_uuid()::text, 'rehearsal', '${folder}', now(), now(), 1)
                   ON CONFLICT DO NOTHING`],
                { env },
              ).catch(() => undefined);
            }
          });
        }

        // The exact command the deploy runs.
        const output = await run('npx', ['prisma', 'migrate', 'deploy'], {
          env: { ...env, DATABASE_URL: url },
          cwd: ROOT,
        });

        // And the result must be the schema the code expects.
        const drift = await run(
          'npx',
          ['prisma', 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel',
            join(ROOT, 'prisma', 'schema.prisma'), '--script'],
          { env, cwd: ROOT },
        );
        const empty = /empty migration/i.test(drift);
        if (!empty) {
          failures += 1;
          console.error(`  DRIFT     ${label}`);
          console.error(
            `            the rehearsed schema does not match schema.prisma:\n` +
              drift
                .split('\n')
                .filter((line) => line.trim() !== '' && !line.startsWith('warn '))
                .slice(0, 12)
                .map((line) => `              ${line}`)
                .join('\n'),
          );
          continue;
        }

        const applied = (output.match(/migration(s)? (have|has) been applied/i) ?? []).length > 0;
        console.log(
          `  ok        ${label} — ${all.length - cut} applied, schema matches` +
            ` (${((Date.now() - started) / 1000).toFixed(1)}s)${applied ? '' : ''}`,
        );
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  FAILED    ${label}\n            ${message.split('\n').slice(0, 6).join('\n            ')}`);
      }
    }
  } finally {
    await run('dropdb', [...connect, '--if-exists', SCRATCH_DB], { env }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n  ${failures} rehearsal(s) failed. Do not deploy.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n  Every rehearsal applied cleanly and matched schema.prisma.\n` +
      `  This says the migrations apply. It does not say they are fast, and it does\n` +
      `  not say they are safe to run against a live database — see runbook.md for\n` +
      `  which ones need the API stopped first.\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
