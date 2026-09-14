import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
