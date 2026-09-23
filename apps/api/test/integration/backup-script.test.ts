import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { judgeSchedule } from '@tp/scheduling-core';
import { TEST_DATABASE_URL, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The backup, and the fact that nothing was reading its answer.
 *
 * `docker/backup/backup.sh` is careful about the things a backup script is
 * usually careless about: it verifies each dump with `pg_restore --list` before
 * the file is renamed into place, and it prunes older dumps only after that
 * verification passes, so the night the dump fails is not the night the last
 * good one is deleted.
 *
 * What it could not do is be *noticed*. Its answer went to a one-line `status`
 * file on the host, which the runbook told an operator to go and read — which
 * is to say, during an incident, after backups have already been silently
 * absent for a week. The backup container is the one scheduled thing in this
 * deployment that is not a worker job, so the watchdog built for those did not
 * cover it either.
 *
 * It now writes into `scheduled_job_runs` like every other schedule, and these
 * tests run the actual shell script to prove it — including the failure path,
 * which is the one that has to work.
 */
suite('the backup script', () => {
  let prisma: PrismaClient;
  let backups: string;

  const url = new URL(TEST_DATABASE_URL ?? '');
  const script = join(process.cwd(), 'docker', 'backup', 'backup.sh');

  const env = (over: Record<string, string> = {}) => ({
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port === '' ? '5432' : url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password) || 'unused',
    PGDATABASE: url.pathname.replace(/^\//, ''),
    BACKUP_DIR: backups,
    BACKUP_INTERVAL_HOURS: '6',
    ...over,
  });

  const run = (over: Record<string, string> = {}): { ok: boolean; output: string } => {
    try {
      const output = execFileSync('sh', [script, 'once'], {
        env: env(over),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, output };
    } catch (error) {
      const shaped = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${shaped.stdout ?? ''}${shaped.stderr ?? ''}` };
    }
  };

  const row = () => prisma.scheduledJobRun.findFirstOrThrow({ where: { name: 'backup' } });

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    backups = mkdtempSync(join(tmpdir(), 'backup-test-'));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * The startup race, which production ran into twice before anyone looked.
   *
   * `docker-compose.prod.yml` has `depends_on: postgres: condition:
   * service_healthy` — and that orders containers within one `compose up` and
   * says nothing about an unsupervised restart. This container is
   * `restart: unless-stopped`, so when the daemon restarts or postgres is
   * recreated beneath it, the backup can come back first and dump into
   * nothing:
   *
   * ```text
   * 2026-09-16T02:37  connection to server at "postgres" ... Connection refused
   * 2026-09-18T10:45  could not translate host name "postgres" to address
   * ```
   *
   * Each wrote FAILED and then slept six hours, so a one-second race became a
   * six-hour-old "the backups are broken" signal — and `record` needs the same
   * database, so no row reached `scheduled_job_runs` either.
   *
   * Run in loop mode rather than `once`, because the wait is the loop's
   * preamble and `once` is the on-demand path that must stay immediate.
   */
  const waitFor = (
    over: Record<string, string>,
  ): { ok: boolean; output: string; elapsedMs: number } => {
    const startedAt = Date.now();
    const result = spawnSync('sh', [script, 'wait'], {
      env: env(over),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      elapsedMs: Date.now() - startedAt,
    };
  };

  it('waits for the database before its first dump, rather than racing a restart', () => {
    const { ok, output, elapsedMs } = waitFor({
      PGHOST: 'postgres-that-does-not-exist.invalid',
      BACKUP_STARTUP_WAIT_SECONDS: '6',
    });

    expect(ok, 'it reported the database as reachable').toBe(false);
    // It waited rather than giving up on the first tick.
    expect(elapsedMs, 'it did not wait at all').toBeGreaterThanOrEqual(6_000);
    expect(output).toContain('did not answer in 6s');
  });

  /**
   * The other half, which is what keeps this honest: bounded, and startup only.
   * A database still unreachable when the wait expires produces the same loud
   * failure it always did — waiting there would turn a real outage into
   * silence.
   */
  it('gives up rather than hanging, so a real outage still fails', () => {
    const { ok, elapsedMs } = waitFor({
      PGHOST: 'postgres-that-does-not-exist.invalid',
      BACKUP_STARTUP_WAIT_SECONDS: '4',
    });
    expect(ok).toBe(false);
    expect(elapsedMs, 'it waited past its own ceiling').toBeLessThan(30_000);
  });

  it('does not spend the wait when the database is already there', () => {
    const { ok, elapsedMs } = waitFor({ BACKUP_STARTUP_WAIT_SECONDS: '120' });
    expect(ok).toBe(true);
    // Nowhere near the ceiling: it asked once, got an answer, and went on.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  /**
   * And that the loop actually calls it.
   *
   * The three tests above drive `wait_for_database` through the `wait`
   * subcommand, which proves the function and says nothing about the wiring —
   * deleting the call from the loop leaves all three passing. That is the same
   * shape as every other guard that tested a decision and not the place the
   * decision is made, so it is asserted here: the wait happens before the loop,
   * once, and not inside it.
   */
  it('runs the wait before the loop, not merely defines it', () => {
    const source = readFileSync(script, 'utf8');
    const loopAt = source.indexOf('while :; do');
    const callAt = source.indexOf('wait_for_database || true');
    expect(loopAt, 'the loop has moved').toBeGreaterThan(0);
    expect(callAt, 'nothing calls wait_for_database before the loop').toBeGreaterThan(0);
    expect(callAt, 'the wait is inside the loop, so it runs before every dump').toBeLessThan(
      loopAt,
    );
  });

  /**
   * `once` is the on-demand path and must stay immediate.
   *
   * With a healthy database this proves nothing — the wait would return at once
   * anyway, and a first version of this test passed happily against a `once`
   * that *did* wait. The claim only bites when the database is slow, so that is
   * where it is asserted: an unreachable host, a thirty-second ceiling, and a
   * failure that arrives in a fraction of it.
   */
  it('does not make an on-demand dump wait, even when the database is unreachable', () => {
    const startedAt = Date.now();
    const { ok, output } = run({
      PGHOST: 'postgres-that-does-not-exist.invalid',
      BACKUP_STARTUP_WAIT_SECONDS: '30',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(ok).toBe(false);
    expect(output).toContain('backup FAILED');
    expect(elapsedMs, 'the on-demand path spent the startup wait').toBeLessThan(15_000);
  });

  it('records a dump where the platform can see it, not only in a file on the host', async () => {
    const { ok, output } = run();
    expect(ok, output).toBe(true);

    const found = await row();
    expect(found.outcome).toBe('OK');
    expect(found.error).toBeNull();
    expect(found.runs).toBe(1);
    expect(found.failures).toBe(0);
    expect(found.lastSucceededAt).not.toBeNull();
    expect(found.durationMs).not.toBeNull();

    // And the status file it always wrote is still written, because somebody on
    // the host at three in the morning should not have to query anything.
    expect(readFileSync(join(backups, 'status'), 'utf8')).toMatch(/ OK /);
  });

  /**
   * The schedule it records is the one it actually keeps.
   *
   * The loop sleeps; it does not follow a clock. Writing a cron pattern here
   * would be a small lie that a reader would later act on, wondering why the
   * dumps do not land on the hour — and the lateness judgement would be built
   * on fixed slots this job does not have.
   */
  it('describes itself as an interval, because that is what it is', async () => {
    run({ BACKUP_INTERVAL_HOURS: '4' });
    expect((await row()).cron).toBe('every:14400');

    const health = judgeSchedule(
      { name: 'backup', cron: 'every:14400', lastFinishedAt: new Date(), lastOutcome: 'OK' },
      'UTC',
    );
    expect(health.verdict).toBe('ok');
    expect(health.intervalMs).toBe(4 * 3_600_000);
  });

  /**
   * The failure path, which is the whole point.
   *
   * A backup that succeeds and is not recorded is a missing line on a
   * dashboard. A backup that *fails* and is not recorded is a deployment whose
   * last restorable dump is older than anybody thinks, and nothing anywhere
   * says so.
   *
   * `pg_dump` is replaced with something that exits non-zero, which is what a
   * full disk, a dead primary or a revoked role look like from in here.
   */
  it('records a failed dump, with the reason, and keeps the last success', async () => {
    expect(run().ok).toBe(true);
    const succeeded = await row();

    const fakeBin = mkdtempSync(join(tmpdir(), 'fake-bin-'));
    writeFileSync(join(fakeBin, 'pg_dump'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakeBin, 'pg_dump'), 0o755);

    const { ok, output } = run({ PATH: `${fakeBin}:${process.env['PATH'] ?? ''}` });
    expect(ok, 'a failed dump must fail the script').toBe(false);
    expect(output).toMatch(/nothing pruned/);

    const failed = await row();
    expect(failed.outcome).toBe('FAILED');
    expect(failed.error).toBe('pg_dump exited non-zero');
    expect(failed.failures).toBe(1);
    expect(failed.runs).toBe(2);

    /**
     * The last success is kept rather than overwritten. The distance between
     * `finishedAt` and `lastSucceededAt` is how long the backups have been
     * broken, and it is the only number that answers "how much would we lose".
     */
    expect(failed.lastSucceededAt?.toISOString()).toBe(succeeded.lastSucceededAt?.toISOString());
    expect(failed.finishedAt?.getTime()).toBeGreaterThanOrEqual(
      failed.lastSucceededAt?.getTime() ?? 0,
    );

    // And it reads as a problem rather than as a recent, healthy run.
    expect(
      judgeSchedule(
        {
          name: 'backup',
          cron: failed.cron,
          lastFinishedAt: failed.finishedAt,
          lastOutcome: failed.outcome,
        },
        'UTC',
      ).verdict,
    ).toBe('failing');
  });

  /**
   * A dump that fails must not take the last good one with it.
   *
   * The pruning happens after the verification, and this is the assertion that
   * keeps it there: after a failed run, the dump from the successful run is
   * still on disk.
   */
  it('prunes nothing on a night the dump fails', async () => {
    run();
    const before = execFileSync('ls', [backups], { encoding: 'utf8' });

    const fakeBin = mkdtempSync(join(tmpdir(), 'fake-bin-'));
    writeFileSync(join(fakeBin, 'pg_dump'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakeBin, 'pg_dump'), 0o755);
    run({ PATH: `${fakeBin}:${process.env['PATH'] ?? ''}` });

    const after = execFileSync('ls', [backups], { encoding: 'utf8' });
    const dumps = (listing: string) => listing.split('\n').filter((one) => one.endsWith('.dump'));
    expect(dumps(after)).toEqual(dumps(before));
  });
});
