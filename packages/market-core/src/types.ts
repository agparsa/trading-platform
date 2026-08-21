import type { CurrencyCode, SymbolSpec } from '@tp/financial-core';

/** A single market observation. Immutable; never mutated in place. */
export interface Tick {
  readonly symbol: string;
  readonly bid: string;
  readonly ask: string;
  /** Milliseconds since epoch, UTC. */
  readonly timestamp: number;
  /** Traded volume attributed to this tick, in lots. '0' when unknown. */
  readonly volume: string;
}

export interface Candle {
  readonly symbol: string;
  readonly resolution: Resolution;
  /** Bucket start time, UTC ms, aligned to the resolution grid. */
  readonly time: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/**
 * Chart resolutions. The string form is the one used on the wire and by the
 * charting library's datafeed; the millisecond form drives bucketing.
 */
export const Resolution = {
  M1: '1',
  M5: '5',
  M15: '15',
  M30: '30',
  H1: '60',
  H4: '240',
  D1: '1D',
} as const;
export type Resolution = (typeof Resolution)[keyof typeof Resolution];

const RESOLUTION_MS: Readonly<Record<Resolution, number>> = {
  [Resolution.M1]: 60_000,
  [Resolution.M5]: 300_000,
  [Resolution.M15]: 900_000,
  [Resolution.M30]: 1_800_000,
  [Resolution.H1]: 3_600_000,
  [Resolution.H4]: 14_400_000,
  [Resolution.D1]: 86_400_000,
};

export function resolutionMs(resolution: Resolution): number {
  return RESOLUTION_MS[resolution];
}

export function isResolution(value: string): value is Resolution {
  return Object.values(Resolution).includes(value as Resolution);
}

/**
 * A weekly trading session, expressed in the trading server's timezone.
 * Days are 0=Sunday..6=Saturday; minutes are from midnight.
 */
export interface SessionWindow {
  readonly day: number;
  readonly openMinute: number;
  readonly closeMinute: number;
}

export interface TradingSession {
  readonly symbol: string;
  /** IANA zone the windows are expressed in, e.g. 'UTC' or 'Europe/London'. */
  readonly timezone: string;
  readonly windows: readonly SessionWindow[];
}

export interface InstrumentDefinition {
  readonly spec: SymbolSpec;
  readonly session: TradingSession;
  /** Currency traders' accounts settle in for this instrument's P&L, if fixed. */
  readonly settlementCurrency?: CurrencyCode;
}
