import type { TradingSession } from '@tp/market-core';

/**
 * Is an instrument tradeable at this instant?
 *
 * Windows are stored per weekday in the session's own IANA timezone, so the
 * calculation converts the instant into that zone before comparing. Using the
 * server's local time here would silently move every session boundary when the
 * server moved, or when a zone's DST offset changed.
 */
export function isSessionOpen(session: TradingSession, atMs: number): boolean {
  const { day, minute } = zonedDayAndMinute(atMs, session.timezone);
  return session.windows.some(
    (window) => window.day === day && minute >= window.openMinute && minute < window.closeMinute,
  );
}

/** Start of the next window, or null when the session never opens again this week. */
export function nextOpenAt(session: TradingSession, atMs: number): number | null {
  const { day, minute } = zonedDayAndMinute(atMs, session.timezone);
  const sorted = [...session.windows].sort((a, b) => a.day - b.day || a.openMinute - b.openMinute);

  for (let offset = 0; offset < 8; offset += 1) {
    const targetDay = (day + offset) % 7;
    for (const window of sorted) {
      if (window.day !== targetDay) continue;
      if (offset === 0 && window.openMinute <= minute) continue;
      const minutesAhead = offset * 1440 + window.openMinute - (day * 0 + minute);
      return atMs + minutesAhead * 60_000;
    }
  }
  return null;
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
