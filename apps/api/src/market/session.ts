import type { SessionWindow, TradingSession } from '@tp/market-core';
import type { MarketState } from '@tp/shared-types';

/**
 * What the market is doing for this instrument, right now (§36).
 *
 * ## Why a state rather than a boolean
 *
 * `isSessionOpen` answers the only question the engine asks, and it is still
 * the whole of the trading decision. What it cannot do is tell a trader why the
 * screen is dead, or when it will not be. `nextOpenAt` existed for that and was
 * never called by anything — so a trader looking at a shut market at the
 * weekend saw a blank chart, a price of `—`, and no word about Sunday evening.
 * The first audit found the same class of fault from the other end (the
 * terminal opening on a closed instrument) and fixed the symptom; this is the
 * vocabulary that lets a screen say the thing outright.
 *
 * ## Precedence, and why it is this order
 *
 * 1. **HALTED** — the kill switch is on. It overrides every session window
 *    there is, and it carries no reopening time because a halt is a decision
 *    somebody has to reverse, not a schedule.
 * 2. **UNKNOWN** — the instrument has no windows configured at all. Before
 *    this, that instrument was reported `closed`, which reads as "the market is
 *    shut" when it means "nobody has said when this trades". Both refuse an
 *    order; only one of them tells an operator to go and fix the configuration.
 * 3. **OPEN**, then **PRE_OPEN**, then **POST_CLOSE**, then **CLOSED**.
 *
 * PRE_OPEN wins over POST_CLOSE when a gap is short enough to be both, because
 * a trader waiting at a screen cares what happens next, not what just stopped.
 *
 * **Only OPEN trades**, and `tradeable` is derived here rather than decided
 * again by each caller — the engine, the ticket and the watchlist read one
 * answer. `isSessionOpen` is now this function's OPEN case, so the two cannot
 * drift apart.
 */
export interface MarketStatus {
  readonly state: MarketState;
  readonly tradeable: boolean;
  readonly opensAt: number | null;
  readonly closesAt: number | null;
}

export interface MarketStatusOptions {
  /** The kill switch, platform- or tenant-wide. Overrides every window. */
  readonly halted?: boolean;
  /** How long before an open the screen should say so. A notice, not an auction. */
  readonly preOpenMinutes?: number;
  /** How long after a close the screen should still explain itself. */
  readonly postCloseMinutes?: number;
}

const MINUTES_PER_WEEK = 7 * 1440;

export function marketStatus(
  session: TradingSession,
  atMs: number,
  options: MarketStatusOptions = {},
): MarketStatus {
  const shut = (state: MarketState, opensAt: number | null = null): MarketStatus => ({
    state,
    tradeable: false,
    opensAt,
    closesAt: null,
  });

  if (options.halted === true) return shut('HALTED');
  if (session.windows.length === 0) return shut('UNKNOWN');

  const ranges = mergedRanges(session.windows);
  const { day, minute } = zonedDayAndMinute(atMs, session.timezone);
  const now = day * 1440 + minute;

  // A wrapping range (Sunday 22:00 through Friday, say) is stored with an end
  // past the week's end, so containment is asked twice: once for this week's
  // position and once for the same instant a week earlier.
  const current = ranges.find(
    (range) =>
      (now >= range.start && now < range.end) ||
      (now + MINUTES_PER_WEEK >= range.start && now + MINUTES_PER_WEEK < range.end),
  );
  if (current !== undefined) {
    /**
     * A market open every minute of the week never closes.
     *
     * Merging leaves crypto as one range covering the whole week, and the
     * arithmetic below would then read "closes in seven days" — which a
     * countdown on a screen would faithfully display, every minute, forever.
     * Whether it closes is a property of the session, not of the instant.
     */
    const coversTheWeek =
      ranges.reduce((total, range) => total + (range.end - range.start), 0) >= MINUTES_PER_WEEK;
    return {
      state: 'OPEN',
      tradeable: true,
      closesAt: coversTheWeek
        ? null
        : instantIn(
            session.timezone,
            atMs,
            (current.end - now + MINUTES_PER_WEEK) % MINUTES_PER_WEEK,
          ),
      opensAt: null,
    };
  }

  const untilOpen = Math.min(
    ...ranges.map((range) => (range.start - now + MINUTES_PER_WEEK) % MINUTES_PER_WEEK),
  );
  const sinceClose = Math.min(
    ...ranges.map((range) => (now - range.end + MINUTES_PER_WEEK) % MINUTES_PER_WEEK),
  );
  const opensAt = instantIn(session.timezone, atMs, untilOpen);

  if (untilOpen <= (options.preOpenMinutes ?? 0)) return shut('PRE_OPEN', opensAt);
  if (sinceClose <= (options.postCloseMinutes ?? 0)) return shut('POST_CLOSE', opensAt);
  return shut('CLOSED', opensAt);
}

/**
 * Is an instrument tradeable at this instant?
 *
 * The one question the engine asks, and now one case of `marketStatus` rather
 * than a second implementation of it. Windows are stored per weekday in the
 * session's own IANA zone, so the calculation converts the instant into that
 * zone before comparing: the server's local time would silently move every
 * session boundary when the server moved, or when a zone's offset changed.
 */
export function isSessionOpen(session: TradingSession, atMs: number): boolean {
  return marketStatus(session, atMs).tradeable;
}

/**
 * The session's windows as minute-of-week ranges, with abutting ones joined.
 *
 * This is what keeps the platform from announcing a close every midnight. The
 * metals week is stored as Sunday 22:00–24:00, then Monday 00:00–24:00, and so
 * on: seven rows that are one continuous session. Left unmerged, a trader mid
 * position on a Tuesday evening would be told the market closes in an hour,
 * every night of the week.
 *
 * The wrap is the same fault at the week's seam, so the last range is extended
 * past the end of the week rather than being a separate one.
 */
function mergedRanges(
  windows: readonly SessionWindow[],
): ReadonlyArray<{ start: number; end: number }> {
  const sorted = windows
    .map((window) => ({
      start: window.day * 1440 + window.openMinute,
      end: window.day * 1440 + window.closeMinute,
    }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  if (
    merged.length > 1 &&
    first !== undefined &&
    last !== undefined &&
    last.end >= MINUTES_PER_WEEK &&
    first.start === 0
  ) {
    last.end = MINUTES_PER_WEEK + first.end;
    merged.shift();
  }
  return merged;
}

/**
 * The instant `minutes` of wall clock from now, in a named zone.
 *
 * Not `atMs + minutes * 60_000`: on the day a zone shifts, a wall-clock day is
 * 23 or 25 hours long, and a naive addition puts Sunday's open an hour out
 * twice a year. The candidate is corrected by reading the zone back at it —
 * the same technique, and the same one-correction-is-enough reasoning, as
 * `startOfTradingDay`.
 */
function instantIn(timeZone: string, atMs: number, minutes: number): number {
  const startOfMinute = Math.floor(atMs / 60_000) * 60_000;
  const { day, minute } = zonedDayAndMinute(startOfMinute, timeZone);
  const wanted = (day * 1440 + minute + minutes) % MINUTES_PER_WEEK;

  const candidate = startOfMinute + minutes * 60_000;
  const landed = zonedDayAndMinute(candidate, timeZone);
  let drift = landed.day * 1440 + landed.minute - wanted;
  if (drift > MINUTES_PER_WEEK / 2) drift -= MINUTES_PER_WEEK;
  if (drift < -MINUTES_PER_WEEK / 2) drift += MINUTES_PER_WEEK;
  return candidate - drift * 60_000;
}

/**
 * Weekday and minute-of-day for an instant, in a named timezone.
 *
 * `Intl.DateTimeFormat` is used rather than manual offset arithmetic because it
 * is the only thing in the platform that knows about daylight saving.
 */
export function zonedDayAndMinute(atMs: number, timeZone: string): { day: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(atMs));
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return { day: dayIndex === -1 ? 0 : dayIndex, minute: (hour % 24) * 60 + minute };
}

/**
 * The instant a DAY order stops being valid: the next midnight in the trading
 * server's timezone.
 *
 * Computed once, when the order is placed, and stored as a timestamp — so
 * nothing downstream has to reason about what a "day" means, and a server that
 * moves timezone cannot silently reinterpret an order already resting.
 *
 * Built from `zonedDayAndMinute` rather than date arithmetic because that is the
 * one function here that knows about daylight saving. On the day a zone shifts,
 * midnight is 23 or 25 hours away, not 24.
 */
export function endOfTradingDay(timeZone: string, atMs: number): number {
  const { minute } = zonedDayAndMinute(atMs, timeZone);
  const minutesLeft = 1440 - minute;
  // Snap to the minute first: the remaining seconds within the current minute
  // would otherwise push the expiry a fraction past midnight.
  const startOfMinute = Math.floor(atMs / 60_000) * 60_000;
  return startOfMinute + minutesLeft * 60_000;
}

/**
 * The instant the current trading day began, in the trading server's zone.
 *
 * The mirror of `endOfTradingDay`, and it exists for the same reason: "today's
 * realized P&L" has to mean one thing across the API, the terminal and any
 * later report, and that thing is a stored timestamp rather than each caller's
 * idea of midnight.
 *
 * The naive subtraction lands an hour off on the day a zone shifts, because a
 * daylight-saving day is 23 or 25 hours long while its wall clock still reads
 * 1440 minutes. One correction is always enough: offsets move by whole hours,
 * once per transition.
 */
export function startOfTradingDay(timeZone: string, atMs: number): number {
  const { minute } = zonedDayAndMinute(atMs, timeZone);
  const startOfMinute = Math.floor(atMs / 60_000) * 60_000;
  const candidate = startOfMinute - minute * 60_000;

  const drift = zonedDayAndMinute(candidate, timeZone).minute;
  if (drift === 0) return candidate;
  // Landing after midnight means subtract the excess; landing before it (late
  // in the previous day) means add the shortfall back.
  return candidate - (drift > 720 ? drift - 1440 : drift) * 60_000;
}
