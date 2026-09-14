/**
 * How long a job waited between being due and being picked up.
 *
 * ## Why this is not `now - job.timestamp`
 *
 * That was the first version, and production said 60,016 ms for a job on a
 * sixty-second cron — every time, for every queue. It read as a worker an
 * entire minute behind. It was not: `timestamp` is when BullMQ *created* the
 * job, and a scheduled job is created as soon as the previous one fires, with a
 * `delay` that holds it until its slot. So the number being reported was the
 * cron interval plus the real lag, and the real lag was the sixteen
 * milliseconds hiding at the end of it.
 *
 * A metric that reports the schedule back to you is worse than no metric: it
 * looks like a finding, and the thing it hides is exactly the thing it was
 * added to show.
 *
 * The moment a job is *due* is `timestamp + delay` — creation time for an
 * immediate job, whose delay is zero, and the slot for a scheduled one.
 */
export function queueLagMs(
  job: { readonly timestamp: number; readonly opts?: { readonly delay?: number } },
  startedAt: number,
): number {
  const dueAt = job.timestamp + (job.opts?.delay ?? 0);
  /**
   * Never negative. A job picked up a millisecond before its slot — the clocks
   * inside Redis and this process are not the same clock — is not early in any
   * sense worth recording, and a negative sample would drag an average below
   * the smallest lag that can actually occur.
   */
  return Math.max(0, startedAt - dueAt);
}


/**
 * Whether this job counts as *the schedule having run*.
 *
 * BullMQ's job scheduler adds its jobs under the name `scheduled`. A manual
 * reconciliation from the admin console, a boot run, and anything else arrives
 * under a different name, and recording those would make the whole mechanism
 * useless in the most misleading way available: an operator who presses "run
 * now" **because** the numbers look stale would reset the clock and hide the
 * dead scheduler they were reacting to. The screen would go green at the exact
 * moment somebody noticed the problem.
 *
 * A function rather than a condition inside the worker because the worker needs
 * Redis to exercise and this rule does not. It lives here beside `queueLagMs`,
 * the other small decision the job wrapper makes.
 */
export function countsAsScheduledRun(
  job: { readonly name: string },
  isScheduledQueue: boolean,
): boolean {
  return isScheduledQueue && job.name === 'scheduled';
}
