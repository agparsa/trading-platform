import { effectiveMarginRate, tickValue, toDecimal, type SymbolSpec } from '@tp/financial-core';
import { MINUTES_PER_WEEK, mergedSessionRanges } from '@tp/shared-types';
import type { SymbolRow, TradingSession } from './queries';

/**
 * An instrument's contract terms, in words a trader can check.
 *
 * Every figure is the server's — the firm's own terms where it has set them,
 * the platform's where it has not — and every derived one is derived with the
 * engine's own functions (`tickValue`, `effectiveMarginRate`), so the screen
 * cannot describe a margin the engine would not charge.
 */

/** A decimal string without trailing zeros: "0.0100" → "0.01", "100.00" → "100". */
export function plain(value: string): string {
  return toDecimal(value).toFixed();
}

/** A rate as a percentage: "0.01" → "1%", "0.005" → "0.5%". */
export function percentOf(rate: string): string {
  return `${toDecimal(rate).mul(100).toFixed()}%`;
}

export interface MarginTerms {
  /** The instrument's own rate, as a percentage. */
  readonly instrument: string;
  /** What this account is charged: the larger of the instrument's rate and 1/leverage. */
  readonly charged: string | null;
  /** Whether the account's leverage, rather than the instrument, sets the rate. */
  readonly leverageBinds: boolean;
}

export function marginTerms(spec: SymbolRow, leverage: number | undefined): MarginTerms {
  const instrument = percentOf(spec.marginRate);
  if (leverage === undefined || leverage <= 0) {
    return { instrument, charged: null, leverageBinds: false };
  }
  const rate = effectiveMarginRate(spec as unknown as SymbolSpec, leverage);
  return {
    instrument,
    charged: `${rate.mul(100).toFixed()}%`,
    leverageBinds: !rate.equals(toDecimal(spec.marginRate)),
  };
}

/** The value of one tick for one lot, in the quote currency. */
export function tickValuePerLot(spec: SymbolRow): string {
  return tickValue(spec as unknown as SymbolSpec, '1').toFixed();
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function clock(minuteOfWeek: number): string {
  const wrapped = ((minuteOfWeek % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  const day = DAYS[Math.floor(wrapped / 1440)] ?? '?';
  const minute = wrapped % 1440;
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/**
 * The week's trading hours, one line per continuous session, in the
 * session's own zone — read with the engine's rule for joining windows, so
 * Sunday 22:00 to Friday 21:00 reads as one session and not seven.
 */
export function sessionLines(session: TradingSession): string[] {
  if (session.windows.length === 0) return ['No trading hours are configured'];
  const ranges = mergedSessionRanges(session.windows);
  if (ranges.length === 1 && ranges[0]!.end - ranges[0]!.start >= MINUTES_PER_WEEK) {
    return ['Around the clock, every day'];
  }
  return ranges.map((range) => `${clock(range.start)} – ${clock(range.end)}`);
}
