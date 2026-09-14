import parser from 'cron-parser';
import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  LATE_FACTOR,
  cronIntervalMs,
  intervalOf,
  isCronPattern,
  judgeSchedule,
  overdueSchedules,
  toleranceFor,
} from './lateness';

const TZ = 'UTC';
const at = (iso: string) => new Date(iso);

/**
 * The parser with no guard in front of it, so the table in `lateness.ts` is
 * measured here rather than remembered.
 */
function cronIntervalMsUnguarded(cron: string): number | null {
  const it = parser.parseExpression(cron, { tz: TZ });
  const first = it.next().getTime();
  return it.next().getTime() - first;
}

describe('cronIntervalMs', () => {
  it('measures the gap between two firings rather than deriving it', () => {
    expect(cronIntervalMs('* * * * *', TZ, at('2026-03-01T00:00:00Z'))).toBe(60_000);
    expect(cronIntervalMs('15 * * * *', TZ, at('2026-03-01T00:00:00Z'))).toBe(3_600_000);
    expect(cronIntervalMs('0 0 * * *', TZ, at('2026-03-01T00:00:00Z'))).toBe(86_400_000);
  });

  /**
   * The patterns a hand-rolled parser gets wrong, which is the argument for
   * using BullMQ's own rather than writing a second one.
   */
  it('handles the patterns nobody wants to implement twice', () => {
    expect(cronIntervalMs('*/7 * * * *', TZ, at('2026-03-01T00:00:00Z'))).toBe(7 * 60_000);
  });

  /**
   * The bug this function was written with and then found: taking the *next*
   * gap on a weekday schedule gives one day, and the real Friday-to-Monday gap
   * is three. Every weekend would have reported a healthy job as stopped, and a
   * watchdog that cries every Saturday is one somebody turns off.
   */
  it('takes the longest gap, not the next one, so a weekend is not an alarm', () => {
    expect(cronIntervalMs('0 0 * * 1-5', TZ, at('2026-03-06T01:00:00Z'))).toBe(3 * 86_400_000);
  });

  it('refuses a pattern it cannot read rather than guessing a default', () => {
    expect(cronIntervalMs('not a cron', TZ)).toBeNull();
  });

  /**
   * The miscount that does not announce itself.
   *
   * A four-field pattern is refused by the parser about half the time and
   * quietly shifted the rest. `0 3 * *`, written for "three in the morning",
   * is accepted, first fires three weeks later and then runs **every minute** —
   * swap accrual charging overnight financing fourteen hundred times a day,
   * with nothing in any log looking wrong.
   *
   * The assertions below pin the parser's behaviour as well as ours, so that
   * this stops being a story and starts being a measurement.
   */
  it('refuses a four-field pattern the parser would quietly read as minutely', () => {
    // What the parser does on its own, unguarded:
    expect(cronIntervalMsUnguarded('0 3 * *')).toBe(60_000);
    expect(cronIntervalMsUnguarded('* * * *')).toBe(60_000);

    // And what this platform does with it:
    expect(isCronPattern('0 3 * *')).toBe(false);
    expect(isCronPattern('* * * *')).toBe(false);
    expect(cronIntervalMs('0 3 * *', TZ)).toBeNull();

    expect(isCronPattern('0 3 * * *')).toBe(true);
    expect(isCronPattern('*/30 * * * * *')).toBe(true);
    expect(isCronPattern('not a cron')).toBe(false);
  });

  /**
   * A schedule is registered with a timezone, so lateness has to be judged in
   * the same one. Around a daylight-saving boundary the two answers differ by
   * an hour, which is enough to alert on a job that ran exactly on time.
   */
  it('measures in the timezone the job is scheduled in', () => {
    // 30 March 2026, 02:00 local does not exist in London: the clocks go
    // forward. A daily 02:30 job therefore has a 23-hour gap across it.
    const gap = cronIntervalMs('30 2 * * *', 'Europe/London', at('2026-03-28T12:00:00Z'));
    expect(gap).toBe(86_400_000);
    const acrossTheChange = cronIntervalMs('30 2 * * *', 'Europe/London', at('2026-03-29T03:00:00Z'));
    expect(acrossTheChange).toBe(86_400_000);
  });
});

describe('intervalOf', () => {
  /**
   * The backup container is not on a cron. It dumps, sleeps six hours and dumps
   * again, so a restart shifts every subsequent run and there are no fixed
   * slots to be late for. Writing an hourly-step cron in its row would have
   * been a small lie that somebody would later act on, wondering why the dumps
   * do not land on the hour.
   */
  it('reads an interval schedule as well as a cron', () => {
    expect(intervalOf('every:21600', TZ)).toBe(6 * 3_600_000);
    expect(intervalOf('every:60', TZ)).toBe(60_000);
    expect(intervalOf('15 * * * *', TZ, at('2026-03-01T00:00:00Z'))).toBe(3_600_000);
  });

  it('refuses a spec in neither form rather than guessing', () => {
    for (const spec of ['every:', 'every:0', 'every:-5', 'every:soon', 'six hours', '']) {
      expect(intervalOf(spec, TZ), spec).toBeNull();
    }
  });

  it('judges an interval schedule the same way it judges a cron', () => {
    const now = at('2026-03-01T12:00:00Z');
    const judge = (hoursAgo: number) =>
      judgeSchedule(
        {
          name: 'backup',
          cron: 'every:21600',
          lastFinishedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
          lastOutcome: 'OK',
        },
        TZ,
        now,
      ).verdict;

    expect(judge(6)).toBe('ok');
    expect(judge(18)).toBe('ok'); // three intervals plus the grace
    expect(judge(19)).toBe('late');
  });
});

describe('judgeSchedule', () => {
  const hourly = { name: 'reconciliation', cron: '15 * * * *' };

  it('calls a job that finished within its own tolerance fine', () => {
    const health = judgeSchedule(
      { ...hourly, lastFinishedAt: at('2026-03-01T11:15:00Z'), lastOutcome: 'OK' },
      TZ,
      at('2026-03-01T12:00:00Z'),
    );
    expect(health.verdict).toBe('ok');
  });

  /**
   * One missed tick is a deploy. Three is a pattern.
   */
  it('tolerates a missed tick and refuses to tolerate three', () => {
    const judge = (hoursAgo: number) =>
      judgeSchedule(
        {
          ...hourly,
          lastFinishedAt: new Date(at('2026-03-01T12:00:00Z').getTime() - hoursAgo * 3_600_000),
          lastOutcome: 'OK',
        },
        TZ,
        at('2026-03-01T12:00:00Z'),
      ).verdict;

    expect(judge(2)).toBe('ok');
    expect(judge(3)).toBe('ok'); // three intervals plus the grace, still inside
    expect(judge(4)).toBe('late');
  });

  it('is exactly as tolerant as it says it is', () => {
    const interval = 3_600_000;
    expect(toleranceFor(interval)).toBe(interval * LATE_FACTOR + GRACE_MS);

    const now = at('2026-03-01T12:00:00Z');
    const justInside = new Date(now.getTime() - toleranceFor(interval));
    const justOutside = new Date(now.getTime() - toleranceFor(interval) - 1);

    expect(
      judgeSchedule({ ...hourly, lastFinishedAt: justInside, lastOutcome: 'OK' }, TZ, now).verdict,
    ).toBe('ok');
    expect(
      judgeSchedule({ ...hourly, lastFinishedAt: justOutside, lastOutcome: 'OK' }, TZ, now).verdict,
    ).toBe('late');
  });

  /**
   * The grace exists so a worker restart does not raise an alarm on the
   * minutely schedules, which is what would teach everybody to ignore this.
   */
  it('does not alarm on a minutely job during a restart', () => {
    const now = at('2026-03-01T12:00:00Z');
    const fourMinutesAgo = new Date(now.getTime() - 4 * 60_000);
    expect(
      judgeSchedule(
        { name: 'outbox-relay', cron: '* * * * *', lastFinishedAt: fourMinutesAgo, lastOutcome: 'OK' },
        TZ,
        now,
      ).verdict,
    ).toBe('ok');
  });

  /**
   * `never-run` is its own answer because it is a different fault with a
   * different fix: nobody is registering the schedules, not a worker that fell
   * over. The sentence says so, because the person reading it at 3am should not
   * have to know that.
   */
  it('says a job has never run, and says what that usually means', () => {
    const health = judgeSchedule({ ...hourly, lastFinishedAt: null, lastOutcome: null }, TZ);
    expect(health.verdict).toBe('never-run');
    expect(health.says).toMatch(/WORKER_ROLE/);
  });

  /**
   * The reading that would otherwise let a job fail all week: it ran a minute
   * ago, so it is not quiet — and it threw, so it is not working.
   */
  it('does not call a job that is failing every minute healthy', () => {
    const now = at('2026-03-01T12:00:00Z');
    const health = judgeSchedule(
      {
        name: 'outbox-relay',
        cron: '* * * * *',
        lastFinishedAt: new Date(now.getTime() - 30_000),
        lastOutcome: 'FAILED',
      },
      TZ,
      now,
    );
    expect(health.verdict).toBe('failing');
  });

  it('reports a cron it cannot read as a configuration fault, not as lateness', () => {
    const health = judgeSchedule(
      { name: 'swap-accrual', cron: '0 0 * *', lastFinishedAt: null, lastOutcome: null },
      TZ,
    );
    expect(health.verdict).toBe('unparsable');
    expect(health.says).toMatch(/not scheduled at all/);
  });
});

describe('overdueSchedules', () => {
  const now = at('2026-03-01T12:00:00Z');

  it('leaves out the healthy ones and puts the worst first', () => {
    const problems = overdueSchedules(
      [
        {
          name: 'fine',
          cron: '15 * * * *',
          lastFinishedAt: new Date(now.getTime() - 60_000),
          lastOutcome: 'OK',
        },
        {
          name: 'late',
          cron: '15 * * * *',
          lastFinishedAt: new Date(now.getTime() - 20 * 3_600_000),
          lastOutcome: 'OK',
        },
        {
          name: 'failing',
          cron: '15 * * * *',
          lastFinishedAt: new Date(now.getTime() - 60_000),
          lastOutcome: 'FAILED',
        },
        { name: 'never', cron: '15 * * * *', lastFinishedAt: null, lastOutcome: null },
        { name: 'broken', cron: 'nonsense', lastFinishedAt: null, lastOutcome: null },
      ],
      TZ,
      now,
    );

    expect(problems.map((one) => one.name)).toEqual(['broken', 'never', 'failing', 'late']);
  });

  it('says nothing at all when everything is on time', () => {
    expect(
      overdueSchedules(
        [
          {
            name: 'fine',
            cron: '* * * * *',
            lastFinishedAt: new Date(now.getTime() - 30_000),
            lastOutcome: 'OK',
          },
        ],
        TZ,
        now,
      ),
    ).toEqual([]);
  });
});
