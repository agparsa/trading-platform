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
