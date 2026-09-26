import { type Decimal, toDecimal } from '../decimal';

export type Side = 'BUY' | 'SELL';

export interface Quote {
  readonly bid: string;
  readonly ask: string;
}

/**
 * The executable price rules. These four functions are the only place in the
 * platform that decides which side of the book a valuation uses.
 *
 * A long is opened by lifting the ASK and closed by hitting the BID; a short is
 * the mirror image. Valuing an open position at the mid price would overstate
 * every account's equity by half the spread per position — a real, systematic
 * error, not a rounding detail.
 */
export function entryPriceFor(side: Side, quote: Quote): Decimal {
  return toDecimal(quote[entrySideOf(side)]);
}

export function exitPriceFor(side: Side, quote: Quote): Decimal {
  return toDecimal(quote[exitSideOf(side)]);
}

/**
 * The side of the book an order in this direction deals on: a buy lifts the
 * ask, a sell hits the bid. For callers that need the quote's own string — a
 * price shown as the feed printed it, or compared as text — rather than a
 * Decimal. `scripts/price-sides.test.ts` holds every other file to these.
 */
export function entrySideOf(side: Side): 'ask' | 'bid' {
  return side === 'BUY' ? 'ask' : 'bid';
}

/** The side a position in this direction is valued and closed on. */
export function exitSideOf(side: Side): 'ask' | 'bid' {
  return side === 'BUY' ? 'bid' : 'ask';
}

/** Price direction multiplier: +1 for a long, -1 for a short. */
export function directionOf(side: Side): Decimal {
  return toDecimal(side === 'BUY' ? 1 : -1);
}

export function oppositeOf(side: Side): Side {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

export function spreadOf(quote: Quote): Decimal {
  return toDecimal(quote.ask).minus(toDecimal(quote.bid));
}
