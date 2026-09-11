/**
 * Monetary and price values cross the wire as decimal strings, never as JSON
 * numbers. `0.1 + 0.2` is a business bug in this system, and IEEE-754 doubles
 * cannot represent every price/volume a broker quotes. The client re-hydrates
 * these into Decimal instances before doing arithmetic.
 */
export type DecimalString = string;

/** Milliseconds since the Unix epoch, always UTC. */
export type EpochMillis = number;

export interface QuoteDto {
  symbol: string;
  bid: DecimalString;
  ask: DecimalString;
  /** ask - bid, in price units (not points). Provided so clients never recompute it. */
  spread: DecimalString;
  timestamp: EpochMillis;
}

export interface CandleDto {
  symbol: string;
  /** Candle open time, UTC. Bucketed to the resolution boundary. */
  time: EpochMillis;
  resolution: string;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
}

export interface AccountStateDto {
  accountId: string;
  currency: string;
  balance: DecimalString;
  equity: DecimalString;
  usedMargin: DecimalString;
  freeMargin: DecimalString;
  /** Percentage. Null when usedMargin is zero (division undefined, not infinite). */
  marginLevel: DecimalString | null;
  floatingPnl: DecimalString;
  realizedPnl: DecimalString;
  commission: DecimalString;
  swap: DecimalString;
  updatedAt: EpochMillis;
}

/**
 * What the platform can say about an instrument's market right now (§36).
 *
 * `sessionOpen: boolean` answered one question — may I trade? — and left the
 * screen with nothing to say for the other twenty-three hours. These six say
 * *why* a market is shut and, where the session table knows, when that ends.
 *
 * Exactly one of them trades. `PRE_OPEN` is a courtesy to the screen, not an
 * auction: this platform accepts no orders before the window opens, and the
 * engine's own check is the same predicate the client is shown.
 */
export const MARKET_STATES = [
  /** Inside a trading window. The only state in which an order is accepted. */
  'OPEN',
  /** Shut, and the next window opens within the pre-open notice period. */
  'PRE_OPEN',
  /** Shut, and the last window closed within the post-close notice period. */
  'POST_CLOSE',
  /** Shut, with the next open known (or `null` if the session never reopens). */
  'CLOSED',
  /**
   * Opening suspended by the kill switch. Indefinite: no reopening time.
   * Closing a position stays available during a halt — see `assertMayOpenRisk`.
   */
  'HALTED',
  /** The instrument has no session windows configured. Never tradeable. */
  'UNKNOWN',
] as const;
export type MarketState = (typeof MARKET_STATES)[number];

export interface MarketStatusDto {
  readonly state: MarketState;
  /**
   * Whether a new position may be opened. True for `OPEN` and nothing else —
   * derived from the state rather than decided again, so the screen and the
   * engine cannot disagree. Closing is a separate question: a halt stops new
   * risk and leaves every exit open.
   */
  readonly tradeable: boolean;
  /** When the market next opens; `null` when open, halted, or never reopening. */
  readonly opensAt: EpochMillis | null;
  /** When the current window closes; `null` unless open. */
  readonly closesAt: EpochMillis | null;
}
