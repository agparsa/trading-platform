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
 * ## Why every position, and not a sample
 *
 * This used to rehearse the last three positions only, justified like so:
 * "checking every prefix is forty-odd database builds for a property that only
 * varies near the end … the last few cover every plausible state of a
 * production database that is behind."
 *
 * That was true when it was written and false by September, when production
 * was **eight** migrations behind and the script checked three. The reasoning
 * had not changed; the world had, and nothing was watching for it. A fixed
 * sample is an assumption with an expiry date on it, and this one expired
 * quietly.
 *
 * So: every position. It is one database build per migration, about five
 * seconds each — five or six minutes for the whole chain, once, before a
 * deploy. The original objection was cost, and the cost turns out to be
 * cheaper than being wrong about which positions matter.
 *
 * `MIGRATION_REHEARSAL_CUTS` still shortens it to the last N while iterating.
 * It is not what you run before deploying.
 *
 * Run it before a deploy. It needs an owner connection, so it is a developer's
 * command rather than something the deploy script calls.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SOURCE_URL = process.env['DATABASE_URL'] ?? '';
const SCRATCH_DB = 'trading_platform_migration_rehearsal';
/**
 * How many "production is this far behind" positions to rehearse.
 *
 * Every one of them unless told otherwise — see the header for why there is no
 * default sample size any more.
 */
const CUT_POINTS =
  process.env['MIGRATION_REHEARSAL_CUTS'] === undefined
    ? Number.POSITIVE_INFINITY
    : Number(process.env['MIGRATION_REHEARSAL_CUTS']);

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
 * A throwaway project holding only the first `count` migrations, and returns
 * the path to its schema.
 *
 * This is how a database "at an older release" is built without checking out an
 * older commit, and the shape matters. `prisma migrate deploy` resolves its
 * migrations directory **relative to the schema it is given** — that is the
 * documented behaviour and the only lever there is — so the schema is copied
 * next to the truncated migrations and `--schema` points at the copy.
 *
 * The previous version tried to do this with `PRISMA_MIGRATIONS_PATH`, which is
 * not a Prisma environment variable. Prisma ignored it, applied the repository's
 * *whole* migrations directory, and succeeded — so the `.catch()` fallback never
 * ran either. Every "a database N migration(s) behind" rehearsal this script
 * ever reported was a fresh full install wearing a label. See `assertApplied`
 * for the check that makes that impossible to repeat.
 */
async function partialProject(count: number, into: string): Promise<string> {
  const prisma = join(into, 'prisma');
  const migrations = join(prisma, 'migrations');
  await mkdir(migrations, { recursive: true });
  await cp(join(ROOT, 'prisma', 'schema.prisma'), join(prisma, 'schema.prisma'));
  await cp(join(MIGRATIONS_DIR, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
  for (const folder of migrationFolders().slice(0, count)) {
    await cp(join(MIGRATIONS_DIR, folder), join(migrations, folder), { recursive: true });
  }
  return join(prisma, 'schema.prisma');
}

/**
 * How many migrations the scratch database believes it has applied.
 *
 * Zero for an empty database: Prisma creates `_prisma_migrations` when it first
 * applies something, so "the table is not there" and "nothing has been applied"
 * are the same state and must not be an error.
 */
async function appliedCount(connect: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const out = await run(
    'psql',
    [
      ...connect,
      '-At',
      '-d',
      SCRATCH_DB,
      '-c',
      `SELECT count(*) FROM _prisma_migrations WHERE to_regclass('_prisma_migrations') IS NOT NULL`,
    ],
    { env },
  ).catch(() => '0');
  const count = Number(out.trim());
  return Number.isFinite(count) ? count : 0;
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
  const depth = Math.min(CUT_POINTS, all.length);
  const cuts = [0, ...Array.from({ length: depth }, (_, i) => all.length - 1 - i)]
    .filter((n) => n >= 0 && n < all.length)
    .filter((n, i, list) => list.indexOf(n) === i)
    .sort((a, b) => a - b);

  console.log(
    `\n  Rehearsing ${all.length} migrations from ${cuts.length} starting points ` +
      `into "${SCRATCH_DB}".` +
      (Number.isFinite(CUT_POINTS)
        ? `\n  MIGRATION_REHEARSAL_CUTS is set, so this is a partial sweep — the deepest\n` +
          `  position checked is ${depth} migration(s) behind. Do not deploy on this alone.`
        : '') +
      `\n`,
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
          const schema = await partialProject(cut, partial);
          /**
           * Run from the repository, point `--schema` at the copy.
           *
           * `cwd` must stay here so `npx` resolves the repository's own Prisma
           * rather than trying to fetch one into a temporary directory — which
           * it does, and which fails. It is the `--schema` path that decides
           * where the migrations are read from.
           */
          await run('npx', ['prisma', 'migrate', 'deploy', '--schema', schema], {
            env: { ...env, DATABASE_URL: url },
            cwd: ROOT,
          });
          /**
           * The setup has to have produced the state it claims to.
           *
           * This is the assertion whose absence let the old version report four
           * successful rehearsals per run while never once building a database
           * that was behind. A setup step that quietly does something else is
           * worse than one that fails, because it takes the report down with it.
           */
          const staged = await appliedCount(connect, env);
          if (staged !== cut) {
            throw new Error(
              `setup was asked for ${cut} migration(s) and produced ${staged}. ` +
                `The "behind" state was not built, so this rehearsal would have ` +
                `proved nothing.`,
            );
          }
        }

        // The exact command the deploy runs.
        const before = await appliedCount(connect, env);
        const output = await run('npx', ['prisma', 'migrate', 'deploy'], {
          env: { ...env, DATABASE_URL: url },
          cwd: ROOT,
        });
        const after = await appliedCount(connect, env);
        /**
         * What the deploy *did*, not what the arithmetic says it should have.
         *
         * The old report printed `all.length - cut` — a computed figure, never
         * an observed one — so it read "1 applied" whether one migration had
         * been applied or fifty-one.
         */
        const applied = after - before;
        if (applied !== all.length - cut) {
          throw new Error(
            `expected this deploy to apply ${all.length - cut} migration(s) and it applied ` +
              `${applied}. The database was not where this rehearsal thought it was.`,
          );
        }

        // And the result must be the schema the code expects.
        const drift = await run(
          'npx',
          [
            'prisma',
            'migrate',
            'diff',
            '--from-url',
            url,
            '--to-schema-datamodel',
            join(ROOT, 'prisma', 'schema.prisma'),
            '--script',
          ],
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

        void output;
        console.log(
          `  ok        ${label} — ${applied} applied, schema matches` +
            ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
        );
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `  FAILED    ${label}\n            ${message.split('\n').slice(0, 6).join('\n            ')}`,
        );
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
