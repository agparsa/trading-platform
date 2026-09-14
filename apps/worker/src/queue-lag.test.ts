import { describe, expect, it } from 'vitest';
import { countsAsScheduledRun, queueLagMs } from './queue-lag';

describe('queue lag', () => {
  it('is the wait since the job was due, for an immediate job', () => {
    expect(queueLagMs({ timestamp: 1_000 }, 1_250)).toBe(250);
  });

  /**
   * The case that made this a function instead of one line.
   *
   * A scheduled job is created the moment the previous one fires and held by a
   * `delay` until its slot. Measuring from creation reported 60,016 ms on a
   * sixty-second cron — the schedule, not the lag — and it looked like a worker
   * a full minute behind. The sixteen milliseconds at the end were the answer.
   */
  it('measures a scheduled job from its slot, not from when it was created', () => {
    const job = { timestamp: 1_000, opts: { delay: 60_000 } };
    expect(queueLagMs(job, 61_016)).toBe(16);
  });

  it('does not report a job picked up early as negative lag', () => {
    expect(queueLagMs({ timestamp: 1_000, opts: { delay: 60_000 } }, 60_999)).toBe(0);
  });

  it('treats a missing delay as no delay', () => {
    expect(queueLagMs({ timestamp: 1_000, opts: {} }, 1_100)).toBe(100);
    expect(queueLagMs({ timestamp: 1_000 }, 1_100)).toBe(100);
  });
});

/**
 * Only the scheduler's own job counts as the schedule running.
 *
 * The failure this prevents is specific and nasty: an operator sees stale
 * numbers, presses "run now" on the admin console, and the act of investigating
 * turns the indicator green — hiding the dead scheduler that caused the stale
 * numbers in the first place.
 */
describe('countsAsScheduledRun', () => {
  it('counts the job the scheduler itself adds', () => {
    expect(countsAsScheduledRun({ name: 'scheduled' }, true)).toBe(true);
  });

  it('does not count a manual run, a boot run, or anything else', () => {
    for (const name of ['manual', 'boot', 'build', 'retry']) {
      expect(countsAsScheduledRun({ name }, true), name).toBe(false);
    }
  });

  it('does not count a queue that has no schedule at all', () => {
    expect(countsAsScheduledRun({ name: 'scheduled' }, false)).toBe(false);
  });
});
