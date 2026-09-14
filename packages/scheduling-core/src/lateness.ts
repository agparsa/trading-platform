/**
 * Whether a scheduled job has gone quiet.
 *
 * ## The failure this exists for
 *
 * Every other thing that goes wrong in this platform says so. An order that
 * cannot be placed returns an error; a webhook that will not deliver is retried
 * and then marked failed; a migration that will not apply stops the deploy. A
 * **schedule that stops** does none of that. It produces no error, no failed
 * job and no log line, because the thing that would have written them never
 * ran. The only evidence is an absence, and nothing was watching for absences.
 *
 * What stops with it is not minor:
 *
 * | Schedule          | What silence costs                                        |
 * | ----------------- | --------------------------------------------------------- |
 * | swap accrual      | overnight financing never charged — money, every night     |
 * | reconciliation    | the eight financial checks stop; drift is found by a human |
 * | maintenance sweep | identity documents kept past their retention — a duty      |
 * | outbox relay      | every event stops leaving; webhooks go quiet, not failed   |
 * | webhook delivery  | deliveries stay due forever                                |
 * | broker health     | a venue's credentials expire unnoticed                     |
 *
 * And it is easy to arrange by accident. `WORKER_ROLE=processor` on every
 * worker leaves nobody registering the schedules; no single process can detect
 * that, because each one is behaving exactly as configured. A wrong
 * `TRADING_SERVER_TIMEZONE`, a Redis flush that takes the scheduler keys, a
 * worker that never came back after a deploy — all look identical from inside:
 * quiet.
 *
 * So the platform records when each schedule last finished, and this decides
 * how long is too long.
 *
 * ## Why the tolerance comes from the cron, not from a constant
 *
 * A fixed "alert after an hour" is wrong in both directions: it is hysterical
 * for a job that runs nightly and blind for one that runs every minute. The
 * interval is computable from the pattern itself, so it is computed — with
 * **BullMQ's own cron parser**, deliberately, because a second implementation
 * of "when does this fire" would eventually disagree with the thing actually
 * doing the firing, and the disagreement would show up as a false alarm at
 * three in the morning.
 */
import parser from 'cron-parser';

/**
 * How many intervals late is late.
 *
 * One interval is not late — a job due at 12:00 that runs at 12:00:03 has an
 * age of one interval plus three seconds the moment before the next one fires,
 * which is normal and not a fault. Two would alert on a single missed tick,
 * which happens during a deploy. Three missed ticks is a pattern rather than an
 * event.
 */
export const LATE_FACTOR = 3;

/**
 * Added on top, for jobs that run often.
 *
 * Three intervals of a one-minute cron is three minutes, and a worker restart
 * takes longer than that. Without a floor, every deploy would raise an alarm on
 * the minutely schedules and teach everybody to ignore this.
 */
export const GRACE_MS = 5 * 60_000;

export interface ScheduledRun {
  readonly name: string;
  /**
   * How this job is scheduled, as configured — so the tolerance is the real
   * one. Either a cron pattern, or `every:<seconds>` for something that runs on
   * a sleep loop rather than a clock. See `intervalOf`.
   */
  readonly cron: string;
  /** When the last run *finished*, successfully or not. Null means it never has. */
  readonly lastFinishedAt: Date | null;
  /** The outcome of that run. */
  readonly lastOutcome: string | null;
}

export type ScheduleVerdict = 'ok' | 'late' | 'never-run' | 'failing' | 'unparsable';

export interface ScheduleHealth {
  readonly name: string;
  readonly verdict: ScheduleVerdict;
  /** Milliseconds since the last finish, or null when there has never been one. */
  readonly ageMs: number | null;
  readonly intervalMs: number | null;
  readonly toleranceMs: number | null;
  /** One sentence an operator can act on. */
  readonly says: string;
}

/**
 * How many firings ahead the interval is measured over.
 *
 * Enough to cross a weekend on a weekday schedule and a month boundary on a
 * monthly one, and small enough to cost nothing.
 */
const LOOKAHEAD = 8;

/**
 * The **longest** gap between firings of a cron pattern, in the near future.
 *
 * Measured rather than derived, so the patterns a hand-rolled version gets
 * wrong — step values, day-of-week lists, month restrictions — need no special
 * case here. With BullMQ's own parser, deliberately: a second implementation of
 * "when does this fire" would eventually disagree with the thing doing the
 * firing, and the disagreement surfaces as a false alarm at three in the
 * morning.
 *
 * ## Why the longest gap and not the next one
 *
 * The first version took the next two occurrences. On `0 0 * * 1-5` — midnight
 * on weekdays — that gives one day when asked on a Tuesday, and the real gap
 * from Friday to Monday is three. The tolerance would have been a third of what
 * the schedule actually requires, and every weekend would have reported a
 * perfectly healthy job as stopped. A watchdog that cries every Saturday is one
 * somebody turns off, and then it is not there on the Saturday that matters.
 *
 * So it is the worst case over the next few firings. That makes an alert on an
 * irregular schedule slower, which is the right direction to be wrong in.
 */
export function cronIntervalMs(cron: string, tz: string, from: Date = new Date()): number | null {
  if (!isCronPattern(cron)) return null;
  try {
    const it = parser.parseExpression(cron, { currentDate: from, tz });
    let previous = it.next().getTime();
    let longest = 0;
    for (let i = 0; i < LOOKAHEAD; i += 1) {
      const next = it.next().getTime();
      longest = Math.max(longest, next - previous);
      previous = next;
    }
    return longest > 0 ? longest : null;
  } catch {
    return null;
  }
}

/**
 * Whether a string is a cron pattern this platform will accept.
 *
 * The field count is checked **before** the parser sees it, and that is not
 * belt-and-braces. `cron-parser` — which is BullMQ's, so it decides when these
 * actually fire — accepts *some* four-field patterns and shifts the fields, so
 * a miscount does not produce an error. Measured, rather than assumed:
 *
 * | Pattern     | Parser says            |
 * | ----------- | ---------------------- |
 * | `0 0 * *`   | refuses it             |
 * | `30 * * *`  | refuses it             |
 * | `* * * *`   | accepts, fires **every minute** |
 * | `0 3 * *`   | accepts, first fires *three weeks later*, then every minute |
 * | `15 2 1 *`  | accepts, first fires *next January*, then every minute |
 *
 * So the miscount fails loudly half the time and silently the other half, and
 * the silent half is the worse one: somebody writing `0 3 * *` for "three in
 * the morning" gets a job that does nothing for weeks and then charges
 * overnight financing fourteen hundred times a day. Nothing in any log would
 * look wrong.
 *
 * Five fields, or six with seconds, and nothing else.
 */
export function isCronPattern(value: string): boolean {
  const fields = value.trim().split(/\s+/).filter((field) => field.length > 0);
  if (fields.length !== 5 && fields.length !== 6) return false;
  try {
    parser.parseExpression(value, { tz: 'UTC' });
    return true;
  } catch {
    return false;
  }
}

/** The age at which a schedule with this interval is considered to have stopped. */
/**
 * The interval of any schedule spec, cron or otherwise.
 *
 * ## Why there is a second form
 *
 * Not everything on a schedule is on a cron. The backup container runs a sleep
 * loop — dump, sleep six hours, dump — which is genuinely different from a cron
 * in a way that matters here: a restart shifts every subsequent run, so there
 * are no fixed slots to be late for. Writing `0 *&#47;6 * * *` in its row would
 * have been a small lie that a reader would later act on, wondering why the
 * dumps do not land on the hour.
 *
 * So a spec is either a cron pattern or `every:<seconds>`, and the second says
 * what it means. Anything else is refused rather than guessed at.
 */
export function intervalOf(spec: string, tz: string, from: Date = new Date()): number | null {
  const every = /^every:(\d+)$/.exec(spec.trim());
  if (every !== null) {
    const seconds = Number(every[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }
  return cronIntervalMs(spec, tz, from);
}

export function toleranceFor(intervalMs: number): number {
  return intervalMs * LATE_FACTOR + GRACE_MS;
}

function human(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)} hours`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/**
 * One schedule's verdict.
 *
 * `never-run` is its own answer rather than an infinitely late `late`, because
 * it means something different and is fixed differently: a schedule that has
 * never run once is almost always nobody registering it — every worker a
 * processor, or the scheduler never deployed — and not a worker that fell over.
 *
 * A failing job is reported separately from a late one **and outranks it**: a
 * job that runs every minute and throws every time is neither quiet nor
 * working, and calling it "ok" because it ran recently is the reading that
 * would let it fail all week.
 */
export function judgeSchedule(run: ScheduledRun, tz: string, now: Date = new Date()): ScheduleHealth {
  const intervalMs = intervalOf(run.cron, tz, now);
  if (intervalMs === null) {
    return {
      name: run.name,
      verdict: 'unparsable',
      ageMs: null,
      intervalMs: null,
      toleranceMs: null,
      says: `'${run.cron}' is not a schedule this platform can read, so ${run.name} is not scheduled at all.`,
    };
  }

  const toleranceMs = toleranceFor(intervalMs);

  if (run.lastFinishedAt === null) {
    return {
      name: run.name,
      verdict: 'never-run',
      ageMs: null,
      intervalMs,
      toleranceMs,
      says: `${run.name} has never run. Usually this means no worker is registering schedules — check WORKER_ROLE.`,
    };
  }

  const ageMs = now.getTime() - run.lastFinishedAt.getTime();

  if (run.lastOutcome === 'FAILED') {
    return {
      name: run.name,
      verdict: 'failing',
      ageMs,
      intervalMs,
      toleranceMs,
      says: `${run.name} last failed, ${human(ageMs)} ago. It is running and not working.`,
    };
  }

  if (ageMs > toleranceMs) {
    return {
      name: run.name,
      verdict: 'late',
      ageMs,
      intervalMs,
      toleranceMs,
      says: `${run.name} last finished ${human(ageMs)} ago, on a schedule that fires every ${human(intervalMs)}.`,
    };
  }

  return {
    name: run.name,
    verdict: 'ok',
    ageMs,
    intervalMs,
    toleranceMs,
    says: `${run.name} finished ${human(ageMs)} ago.`,
  };
}

/** Every schedule that is not `ok`, worst first. */
export function overdueSchedules(
  runs: readonly ScheduledRun[],
  tz: string,
  now: Date = new Date(),
): readonly ScheduleHealth[] {
  const order: Record<ScheduleVerdict, number> = {
    unparsable: 0,
    'never-run': 1,
    failing: 2,
    late: 3,
    ok: 4,
  };
  return runs
    .map((run) => judgeSchedule(run, tz, now))
    .filter((health) => health.verdict !== 'ok')
    .sort((a, b) => order[a.verdict] - order[b.verdict]);
}
