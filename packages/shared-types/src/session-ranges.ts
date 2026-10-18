/**
 * A trading session's weekly windows as minute-of-week ranges, with abutting
 * ones joined.
 *
 * The one rule for reading a session, shared by the engine (which decides
 * whether a market is open) and the screens (which say when it trades), so
 * the two cannot describe the same week differently.
 *
 * This is what keeps the platform from announcing a close every midnight. The
 * metals week is stored as Sunday 22:00–24:00, then Monday 00:00–24:00, and so
 * on: seven rows that are one continuous session. Left unmerged, a trader mid
 * position on a Tuesday evening would be told the market closes in an hour,
 * every night of the week — and a contract screen would list seven sessions
 * where there is one.
 *
 * The wrap is the same fault at the week's seam, so the last range is extended
 * past the end of the week rather than being a separate one: `end` can exceed
 * `MINUTES_PER_WEEK`.
 */
export const MINUTES_PER_WEEK = 7 * 1440;

/** Days 0 = Sunday .. 6 = Saturday; minutes from midnight in the session's zone. */
export interface WeeklyWindow {
  readonly day: number;
  readonly openMinute: number;
  readonly closeMinute: number;
}

export interface WeekRange {
  /** Minute of the week the range opens, 0 = Sunday 00:00. */
  start: number;
  /** Minute of the week it closes; past `MINUTES_PER_WEEK` when it wraps. */
  end: number;
}

export function mergedSessionRanges(windows: readonly WeeklyWindow[]): WeekRange[] {
  const sorted = windows
    .map((window) => ({
      start: window.day * 1440 + window.openMinute,
      end: window.day * 1440 + window.closeMinute,
    }))
    .sort((a, b) => a.start - b.start);

  const merged: WeekRange[] = [];
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
