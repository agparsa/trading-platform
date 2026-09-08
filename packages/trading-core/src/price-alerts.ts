import { toDecimal } from '@tp/financial-core';
import type { PriceRange } from './price-range';

/** Which way the market has to move for the alert to be worth sending. */
export type PriceAlertCondition = 'ABOVE' | 'BELOW';

/**
 * Which half of the book the alert watches.
 *
 * There is no single "price" for an instrument, and picking one silently is how
 * an alert fires at a number the trader never saw. A long is marked at the bid
 * and closed at the bid; a buy is filled at the ask. `MID` is neither, and is
 * offered because it is what most charts draw — but it is never a price anyone
 * can deal at, which is why it is not the default.
 */
export type PriceAlertSource = 'BID' | 'ASK' | 'MID';

export interface PriceAlertLevel {
  readonly condition: PriceAlertCondition;
  readonly source: PriceAlertSource;
  /** The level, as a decimal string. */
  readonly price: string;
}

/**
 * The extremes of the watched price over everything the market printed.
 *
 * `MID` is derived from the extremes of both halves rather than from the mid of
 * each tick, which is the conservative direction: the widest mid the window can
 * justify. An alert that fires on a spread that briefly gaped is a nuisance; an
 * alert that misses a move because the mid was averaged away is a trader who
 * did not find out.
 */
export function watchedRange(
  source: PriceAlertSource,
  range: PriceRange,
): { readonly low: string; readonly high: string } {
  if (source === 'BID') return { low: range.minBid, high: range.maxBid };
  if (source === 'ASK') return { low: range.minAsk, high: range.maxAsk };
  return {
    low: toDecimal(range.minBid).plus(range.minAsk).dividedBy(2).toString(),
    high: toDecimal(range.maxBid).plus(range.maxAsk).dividedBy(2).toString(),
  };
}

/**
 * Whether the market went where the alert was waiting for it to go.
 *
 * Evaluated over the *range*, not the latest tick, for the same reason a stop
 * loss is: a market that jumps from 4590 to 4610 has passed 4600, and a trader
 * who asked to be told at 4600 is not helped by an alert that stayed silent
 * because no tick printed exactly there.
 *
 * The boundary is inclusive. "Tell me at 4600" is a request about reaching
 * 4600, not about exceeding it, and a trader who watches the price touch their
 * number and hears nothing concludes the feature is broken — correctly.
 */
export function priceAlertTriggered(level: PriceAlertLevel, range: PriceRange): boolean {
  const { low, high } = watchedRange(level.source, range);
  const target = toDecimal(level.price);
  return level.condition === 'ABOVE'
    ? toDecimal(high).greaterThanOrEqualTo(target)
    : toDecimal(low).lessThanOrEqualTo(target);
}

/**
 * The price to report in the alert.
 *
 * Deliberately the price as it stands now, not the extreme that triggered the
 * alert. The extreme has already gone; telling a trader "gold reached 4600" and
 * showing them 4593 on the same screen reads as a bug, and the number they can
 * act on is the one that is still there. The level they asked about is carried
 * separately, so nothing is lost.
 *
 * Takes a single quote rather than a range on purpose — "the price now" has no
 * meaning over a window, and accepting one would invite a caller to pass the
 * window and get an extreme back without noticing.
 */
export function priceAlertObserved(
  source: PriceAlertSource,
  quote: { readonly bid: string; readonly ask: string },
): string {
  if (source === 'BID') return quote.bid;
  if (source === 'ASK') return quote.ask;
  return toDecimal(quote.bid).plus(quote.ask).dividedBy(2).toString();
}
