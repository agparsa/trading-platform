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
  return side === 'BUY' ? toDecimal(quote.ask) : toDecimal(quote.bid);
}

export function exitPriceFor(side: Side, quote: Quote): Decimal {
  return side === 'BUY' ? toDecimal(quote.bid) : toDecimal(quote.ask);
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
