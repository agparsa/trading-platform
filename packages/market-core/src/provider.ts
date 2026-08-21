import type { Candle, InstrumentDefinition, Resolution, Tick } from './types';

/**
 * The port every market-data source implements.
 *
 * The trading engine depends on this interface and nothing else. Swapping the
 * internal simulator for a broker feed, or running both side by side for
 * reconciliation, must not require a single change inside the engine.
 */
export interface MarketDataProvider {
  readonly name: string;

  /** Instruments this provider can quote. Loaded once at startup. */
  listInstruments(): Promise<readonly InstrumentDefinition[]>;

  /** Latest tick, or null when the provider has not yet quoted this symbol. */
  getLatestTick(symbol: string): Promise<Tick | null>;

  /** Historical candles in ascending time order, `from`/`to` in UTC ms. */
  getCandles(
    symbol: string,
    resolution: Resolution,
    from: number,
    to: number,
  ): Promise<readonly Candle[]>;

  /**
   * Subscribe to a symbol's tick stream. Returns an unsubscribe function.
   * Implementations must never invoke the listener synchronously from within
   * `subscribe` itself — that would re-enter the caller mid-construction.
   */
  subscribe(symbol: string, listener: TickListener): Unsubscribe;

  /** Begin producing data. Idempotent. */
  start(): Promise<void>;
  /** Stop producing data and release resources. Idempotent. */
  stop(): Promise<void>;
}

export type TickListener = (tick: Tick) => void;
export type Unsubscribe = () => void;

/**
 * How stale a quote may be before the engine refuses to trade on it.
 *
 * A price from 30 seconds ago is not a price. Executing against one is how a
 * platform gives away money during a feed outage, so staleness is a first-class
 * concept rather than an afterthought.
 */
export interface QuoteFreshnessPolicy {
  readonly maxAgeMs: number;
}

export const DEFAULT_FRESHNESS: QuoteFreshnessPolicy = { maxAgeMs: 5_000 };

export function isTickFresh(
  tick: Tick,
  nowMs: number,
  policy: QuoteFreshnessPolicy = DEFAULT_FRESHNESS,
): boolean {
  const age = nowMs - tick.timestamp;
  // A tick from the future means clock skew somewhere; treat it as unusable.
  return age >= 0 && age <= policy.maxAgeMs;
}
