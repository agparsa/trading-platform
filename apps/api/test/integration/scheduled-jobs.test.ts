import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { judgeSchedule, overdueSchedules } from '@tp/scheduling-core';
import { ScheduleLogService } from '../../../worker/src/jobs/schedule-log.service';
import type { PrismaService } from '../../../worker/src/prisma.service';
import { createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * A scheduled job that stops is the one failure here that says nothing.
 *
 * Everything else announces itself. An order that cannot be placed returns an
 * error; a webhook that will not deliver is retried and then marked failed; a
 * migration that will not apply stops the deploy. A schedule that stops
 * produces no error, no failed job and no log line, because the process that
 * would have written them never ran.
 *
 * What stops with it is swap accrual — money, every night — the eight
 * reconciliation checks, the sweep that purges identity documents at their
 * retention limit, and the outbox relay that is how events leave this platform
 * at all. `WORKER_ROLE=processor` on every worker is enough to arrange it, and
 * no single process can detect that: each one is behaving exactly as told.
 *
 * So the platform records each run, and these are the properties that make the
 * record worth trusting.
 */
suite('scheduled jobs', () => {
  let prisma: PrismaClient;
  let log: ScheduleLogService;

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    log = new ScheduleLogService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const row = (name: string) => prisma.scheduledJobRun.findFirstOrThrow({ where: { name } });

  it('records a run that worked, with how long it took', async () => {
    const startedAt = new Date('2026-03-01T12:00:00Z');
    await log.started('reconciliation', '15 * * * *', startedAt);
    await log.finished('reconciliation', 'OK', { startedAt }, new Date('2026-03-01T12:00:04Z'));

    const found = await row('reconciliation');
    expect(found.outcome).toBe('OK');
    expect(found.durationMs).toBe(4000);
    expect(found.runs).toBe(1);
    expect(found.failures).toBe(0);
    expect(found.lastSucceededAt?.toISOString()).toBe('2026-03-01T12:00:04.000Z');
  });

  /**
   * A job that runs every minute and throws every time is neither quiet nor
   * working. Keeping the last *success* apart from the last *finish* is what
   * makes the difference visible: the distance between them is how long it has
   * been broken.
   */
  it('keeps the last success apart from the last finish', async () => {
    const good = new Date('2026-03-01T12:00:00Z');
    await log.started('outbox-relay', '* * * * *', good);
    await log.finished('outbox-relay', 'OK', { startedAt: good }, good);

    const bad = new Date('2026-03-01T12:01:00Z');
    await log.started('outbox-relay', '* * * * *', bad);
    await log.finished(
      'outbox-relay',
      'FAILED',
      { startedAt: bad, error: 'the subscriber refused' },
      bad,
    );

    const found = await row('outbox-relay');
    expect(found.outcome).toBe('FAILED');
    expect(found.error).toBe('the subscriber refused');
    expect(found.finishedAt?.toISOString()).toBe('2026-03-01T12:01:00.000Z');
    expect(found.lastSucceededAt?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(found.runs).toBe(2);
    expect(found.failures).toBe(1);

    // And it is not called healthy for having run a moment ago.
    expect(
      judgeSchedule(
        {
          name: found.name,
          cron: found.cron,
          lastFinishedAt: found.finishedAt,
          lastOutcome: found.outcome,
        },
        'UTC',
        new Date('2026-03-01T12:01:30Z'),
      ).verdict,
    ).toBe('failing');
  });

  /**
   * A success after a failure clears the reason.
   *
   * A stale error beside a healthy job is how an operations screen teaches
   * people to ignore it.
   */
  it('clears the reason once the job works again', async () => {
    const bad = new Date('2026-03-01T12:00:00Z');
    await log.started('broker-health', '* * * * *', bad);
    await log.finished(
      'broker-health',
      'FAILED',
      { startedAt: bad, error: 'venue timed out' },
      bad,
    );

    const good = new Date('2026-03-01T12:01:00Z');
    await log.started('broker-health', '* * * * *', good);
    await log.finished('broker-health', 'OK', { startedAt: good }, good);

    const found = await row('broker-health');
    expect(found.error).toBeNull();
    expect(found.outcome).toBe('OK');
    expect(found.failures).toBe(1);
  });

  /**
   * The cron is rewritten on every start, because lateness must be judged
   * against the schedule in force rather than the one that was in force when
   * the row was first written. A tolerance computed from a pattern nobody uses
   * is an alarm that fires for the wrong reason, or not at all.
   */
  it('follows the schedule when it changes', async () => {
    const first = new Date('2026-03-01T12:00:00Z');
    await log.started('swap-accrual', '0 0 * * *', first);
    await log.finished('swap-accrual', 'OK', { startedAt: first }, first);

    const second = new Date('2026-03-01T13:00:00Z');
    await log.started('swap-accrual', '0 3 * * 1', second);

    expect((await row('swap-accrual')).cron).toBe('0 3 * * 1');
  });

  /**
   * A run in flight clears the previous outcome rather than leaving it, so a
   * reader cannot mistake last night's success for this run having finished.
   */
  it('does not leave the last outcome standing while a run is in flight', async () => {
    const first = new Date('2026-03-01T12:00:00Z');
    await log.started('maintenance', '30 * * * *', first);
    await log.finished('maintenance', 'OK', { startedAt: first }, first);

    await log.started('maintenance', '30 * * * *', new Date('2026-03-01T13:30:00Z'));

    const found = await row('maintenance');
    expect(found.outcome).toBeNull();
    expect(found.finishedAt).toBeNull();
    expect(found.durationMs).toBeNull();
    // The success is still there, which is what lateness is judged on.
    expect(found.lastSucceededAt?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });

  /**
   * The arrangement this whole mechanism exists to catch: every worker a
   * processor, nobody registering schedules, everything else perfectly healthy.
   * It looks like an empty table, and an empty table has to read as a fault.
   */
  it('reads an empty table as nothing ever having been scheduled', async () => {
    const rows = await prisma.scheduledJobRun.findMany();
    expect(rows).toHaveLength(0);

    // Which is what the health probe reports as down; the judgement itself is
    // about a job that has a row and no finish.
    const health = judgeSchedule(
      { name: 'reconciliation', cron: '15 * * * *', lastFinishedAt: null, lastOutcome: null },
      'UTC',
    );
    expect(health.verdict).toBe('never-run');
    expect(health.says).toMatch(/WORKER_ROLE/);
  });

  it('judges every recorded schedule against its own cron', async () => {
    const now = new Date('2026-03-02T12:00:00Z');
    const nightly = new Date('2026-03-01T00:00:00Z'); // 36 hours ago
    await log.started('swap-accrual', '0 0 * * *', nightly);
    await log.finished('swap-accrual', 'OK', { startedAt: nightly }, nightly);

    const minutely = new Date('2026-03-02T11:00:00Z'); // an hour ago
    await log.started('outbox-relay', '* * * * *', minutely);
    await log.finished('outbox-relay', 'OK', { startedAt: minutely }, minutely);

    const rows = await prisma.scheduledJobRun.findMany();
    const problems = overdueSchedules(
      rows.map((one) => ({
        name: one.name,
        cron: one.cron,
        lastFinishedAt: one.finishedAt,
        lastOutcome: one.outcome,
      })),
      'UTC',
      now,
    );

    // 36 hours is inside a nightly job's tolerance; an hour is far outside a
    // minutely one's. A single fixed threshold would have got both wrong.
    expect(problems.map((one) => one.name)).toEqual(['outbox-relay']);
  });
});
