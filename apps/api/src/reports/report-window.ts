import { endOfTradingDay, startOfTradingDay } from '../market/session';

/**
 * A report window asked for as **dates**, resolved in the trading server's
 * timezone.
 *
 * `reports.md` has a section called "The window column is the design" that
 * reasons carefully about *which timestamp* each kind is windowed on — created
 * or updated, opened or closed — because getting that wrong produces a file
 * that looks complete and is not. It says nothing about *which timezone*, and
 * the panel had quietly chosen one:
 *
 * ```ts
 * from: new Date(`${from}T00:00:00.000Z`).toISOString(),
 * to:   new Date(`${to}T23:59:59.999Z`).toISOString(),
 * ```
 *
 * An operator picks 1–31 March in a date picker and gets **1 March 00:00 UTC to
 * 31 March 23:59:59.999 UTC**. Every other "day" in this platform — today's
 * P&L, a DAY order's expiry, the swap accrual key, a trading-day statement — is
 * midnight in `TRADING_SERVER_TIMEZONE`. On a server at UTC+9 those disagree by
 * nine hours: the first nine hours of 1 March are missing from the file, and
 * nine hours of April are in it, under a heading that says March.
 *
 * `TRADING_SERVER_TIMEZONE` is `UTC` in both shipped examples, so this is
 * latent rather than live — and it stops being latent the moment anybody sets
 * the broker timezone the knob exists for, which for an FX venue is the normal
 * case.
 *
 * ## Why here rather than in the panel
 *
 * The API's contract is absolute instants, and that is right: unambiguous, and
 * an integration can ask for any window it likes. What was missing was a way to
 * say *a date*, which is what a person means. Resolving it on the server keeps
 * the timezone where the timezone lives, needs no new client configuration, and
 * reuses `startOfTradingDay` / `endOfTradingDay` — so a window over a week
 * containing a clock change is right by construction rather than by a second
 * implementation nobody swept.
 */

/** `2026-03-01`, and nothing else. An instant keeps its own meaning. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

/**
 * Midnight that begins this date, in `timeZone`.
 *
 * Anchored by parsing the date as UTC noon and walking back to the local
 * midnight: noon is far enough from either edge that no offset on earth, and no
 * clock change, lands it on the previous or the next date.
 */
export function startOfDateIn(timeZone: string, date: string): number {
  return startOfTradingDay(timeZone, Date.parse(`${date}T12:00:00.000Z`));
}

/**
 * The last instant of this date, in `timeZone`.
 *
 * One millisecond before the next midnight, because the worker's queries
 * compare with `lte`: a row stamped exactly at the next midnight belongs to the
 * next day's report and must not appear in both.
 */
export function endOfDateIn(timeZone: string, date: string): number {
  return endOfTradingDay(timeZone, startOfDateIn(timeZone, date)) - 1;
}

/**
 * Turns whatever the request said into the instants `readWindow` bounds.
 *
 * A date becomes that trading day's edge; anything else is passed through
 * untouched, so an integration sending an ISO instant with an offset gets
 * exactly the window it asked for.
 */
export function resolveWindowInput(
  timeZone: string,
  from: unknown,
  to: unknown,
): { readonly from: unknown; readonly to: unknown } {
  return {
    from: isDateOnly(from) ? new Date(startOfDateIn(timeZone, from)).toISOString() : from,
    to: isDateOnly(to) ? new Date(endOfDateIn(timeZone, to)).toISOString() : to,
  };
}
