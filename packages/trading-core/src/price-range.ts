import type { CloseReason, OrderSide } from '@tp/shared-types';
import { evaluateProtectiveTrigger, type ProtectiveLevels, type Quote } from './protective-orders';
import { shouldTriggerPending, waitsForFall, type PendingOrderType } from './pending-orders';

/**
 * Evaluating against a range of prices rather than a single one.
 *
 * When the engine is busier than the feed, several ticks are coalesced into the
 * extremes the market reached (see `TickWindow` in `@tp/market-core`). The
 * question then is not "is the price past the level now" but "did the market
 * trade through the level at any point" — which is the question a stop-loss has
 * always really been asking.
 *
 * Detection uses the extremes. Execution still happens at the current price:
 * the extreme has already passed, and filling at a price nobody can deal at
 * would be inventing a fill.
 */
export interface PriceRange {
  readonly minBid: string;
  readonly maxBid: string;
  readonly minAsk: string;
  readonly maxAsk: string;
}

/**
 * The worst price the position saw, from its own point of view.
 *
 * A long exits on the bid, so its adverse extreme is the lowest bid; a short
 * exits on the ask, so its adverse extreme is the highest ask.
 */
export function adverseQuote(side: OrderSide, range: PriceRange): Quote {
  return side === 'BUY'
    ? { bid: range.minBid, ask: range.minAsk }
    : { bid: range.maxBid, ask: range.maxAsk };
}

/** The best price the position saw, the mirror of `adverseQuote`. */
export function favourableQuote(side: OrderSide, range: PriceRange): Quote {
  return side === 'BUY'
    ? { bid: range.maxBid, ask: range.maxAsk }
    : { bid: range.minBid, ask: range.minAsk };
}

/**
 * Protective levels, evaluated across everything the market printed.
 *
 * The adverse extreme is tested **first**, which preserves the platform's
 * existing rule for an ambiguous tick: when a window spans both the stop-loss
 * and the take-profit, nobody can know which came first, and the stop wins.
 * Deciding the other way would let a burst of ticks turn a losing position into
 * a winning one on the strength of an ordering the engine never observed.
 */
export function evaluateProtectiveTriggerOverRange(
  side: OrderSide,
  levels: ProtectiveLevels,
  range: PriceRange,
): CloseReason | null {
  const worst = evaluateProtectiveTrigger(side, levels, adverseQuote(side, range));
  if (worst !== null) return worst;
  return evaluateProtectiveTrigger(side, levels, favourableQuote(side, range));
}

/**
 * Did a resting order's price come up at any point in the window?
 *
 * Each of the four order types waits for movement in one direction, so each is
 * tested against the extreme in that direction — `waitsForFall` already knows
 * which, and is the same function the single-tick path uses.
 */
export function shouldTriggerPendingOverRange(
  type: PendingOrderType,
  side: OrderSide,
  restingPrice: string,
  range: PriceRange,
): boolean {
  const falling = waitsForFall(type, side);
  const quote: Quote = falling
    ? { bid: range.minBid, ask: range.minAsk }
    : { bid: range.maxBid, ask: range.maxAsk };
  return shouldTriggerPending(type, side, restingPrice, quote);
}

/**
 * The best exit price seen in the window, for a trailing stop to follow.
 *
 * A trailing stop that only saw the latest tick would fail to ratchet through a
 * spike it was busy during, and then sit further from the market than the trader
 * asked for.
 */
export function bestExitInRange(side: OrderSide, range: PriceRange): string {
  return side === 'BUY' ? range.maxBid : range.minAsk;
}
