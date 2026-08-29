import { toDecimal } from '@tp/financial-core';
import type { Tick } from './types';

/**
 * What the market did while the engine was busy.
 *
 * The trigger engine processes one pass per symbol at a time. Ticks arriving
 * mid-pass used to be dropped, which was fast and had a real cost: if the market
 * printed a stop level on a dropped tick and moved on, the stop was never
 * evaluated against the price that should have fired it. That is a guarantee
 * failing at exactly the moment stops matter most — a fast market.
 *
 * Queueing every tick instead would trade one failure for another: unbounded
 * memory, and an engine falling further behind until it fires stops against
 * prices minutes old.
 *
 * So ticks are **coalesced**, not queued. The window keeps the extremes seen
 * since the last pass and the most recent tick — four decimals and a reference,
 * regardless of how many ticks arrive. Detection then asks "did the market trade
 * through this level?", which the extremes answer exactly, while execution still
 * happens at the current price.
 */
export interface PriceRange {
  readonly minBid: string;
  readonly maxBid: string;
  readonly minAsk: string;
  readonly maxAsk: string;
}

export interface CoalescedTick extends PriceRange {
  readonly symbol: string;
  /** The most recent tick in the window — what the market is doing *now*. */
  readonly latest: Tick;
  /** How many ticks this window represents. 1 means nothing was coalesced. */
  readonly observed: number;
}

/**
 * Compares two prices and returns the original string, never a converted one.
 *
 * The comparison is decimal, not `Number`. These extremes decide whether the
 * market traded through a stop level — the one question the whole window
 * exists to answer — so a comparison that rounds is a comparison that can
 * answer it wrongly. `4583.5750000000003 <= 4583.575` is exactly the kind of
 * difference that decides whether a stop fired, and it is exactly the kind of
 * difference binary floating point invents.
 *
 * The *returned* value is always one of the inputs, unparsed, so no rounding
 * enters the range even in principle.
 */
function lower(a: string, b: string): string {
  return toDecimal(a).lte(toDecimal(b)) ? a : b;
}

function higher(a: string, b: string): string {
  return toDecimal(a).gte(toDecimal(b)) ? a : b;
}

export class TickWindow {
  private readonly windows = new Map<string, CoalescedTick>();

  /** Fold a tick into its symbol's window. */
  observe(tick: Tick): void {
    const existing = this.windows.get(tick.symbol);
    if (existing === undefined) {
      this.windows.set(tick.symbol, {
        symbol: tick.symbol,
        latest: tick,
        minBid: tick.bid,
        maxBid: tick.bid,
        minAsk: tick.ask,
        maxAsk: tick.ask,
        observed: 1,
      });
      return;
    }
    this.windows.set(tick.symbol, {
      symbol: tick.symbol,
      latest: tick,
      minBid: lower(existing.minBid, tick.bid),
      maxBid: higher(existing.maxBid, tick.bid),
      minAsk: lower(existing.minAsk, tick.ask),
      maxAsk: higher(existing.maxAsk, tick.ask),
      observed: existing.observed + 1,
    });
  }

  /**
   * Take a symbol's window and clear it.
   *
   * Draining before the pass rather than after is deliberate: ticks arriving
   * *during* the pass accumulate into a fresh window and are picked up by the
   * next one, so nothing printed is ever missed.
   */
  drain(symbol: string): CoalescedTick | null {
    const window = this.windows.get(symbol);
    if (window === undefined) return null;
    this.windows.delete(symbol);
    return window;
  }

  has(symbol: string): boolean {
    return this.windows.has(symbol);
  }

  get size(): number {
    return this.windows.size;
  }
}

/** A single tick, as a window of one. Used where a range is expected. */
export function windowOf(tick: Tick): CoalescedTick {
  return {
    symbol: tick.symbol,
    latest: tick,
    minBid: tick.bid,
    maxBid: tick.bid,
    minAsk: tick.ask,
    maxAsk: tick.ask,
    observed: 1,
  };
}
