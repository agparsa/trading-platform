import { DomainError, type OrderSide, TradingErrorCode } from '@tp/shared-types';
import {
  entryPriceFor,
  isOnGrid,
  normalizePrice,
  type SymbolSpec,
  toDecimal,
} from '@tp/financial-core';
import type { Quote } from './protective-orders';

/**
 * Resting orders — LIMIT and STOP.
 *
 * The whole of the logic is one comparison, but which comparison depends on both
 * the type and the side, and getting it backwards turns a limit order into a
 * market order at the worst possible moment. So it lives here, in one place,
 * with the reasoning written down and every combination tested.
 *
 * A resting order is measured against the **executable entry price** — the ask
 * for a buy, the bid for a sell — because that is the price the trader would
 * actually pay. Measuring a buy against the bid would fire it at a price nobody
 * could deal at.
 */

export type PendingOrderType = 'LIMIT' | 'STOP';

export function isPendingOrderType(type: string): type is PendingOrderType {
  return type === 'LIMIT' || type === 'STOP';
}

/**
 * Does this order want the market to come *down* to it?
 *
 *   BUY LIMIT   — buy cheaper than now, so wait for the ask to fall.
 *   SELL STOP   — sell into weakness, so wait for the bid to fall.
 *
 * The other two want the market to come up:
 *
 *   SELL LIMIT  — sell dearer than now, so wait for the bid to rise.
 *   BUY STOP    — buy a breakout, so wait for the ask to rise.
 */
export function waitsForFall(type: PendingOrderType, side: OrderSide): boolean {
  return type === 'LIMIT' ? side === 'BUY' : side === 'SELL';
}

/**
 * Would this resting order fire against this quote?
 *
 * Comparisons are inclusive: an order resting exactly at the traded price has
 * been reached. Requiring the market to trade *through* it would leave orders
 * sitting unfilled at a price the market printed.
 */
export function shouldTriggerPending(
  type: PendingOrderType,
  side: OrderSide,
  restingPrice: string,
  quote: Quote,
): boolean {
  const executable = entryPriceFor(side, quote);
  const resting = toDecimal(restingPrice);
  return waitsForFall(type, side) ? executable.lte(resting) : executable.gte(resting);
}

/**
 * Validate a resting price at the moment it is placed.
 *
 * An order that would trigger immediately is not a resting order — it is a
 * market order the trader did not ask for, and it fires on the next tick at a
 * price they never saw. Rejecting it at the boundary makes the mistake visible
 * while it is still a typo.
 */
export function validatePendingPrice(
  spec: SymbolSpec,
  type: PendingOrderType,
  side: OrderSide,
  restingPrice: string,
  quote: Quote,
): void {
  const price = toDecimal(restingPrice);
  if (price.lte(0)) {
    throw new DomainError(TradingErrorCode.INVALID_PRICE, 'Order price must be positive', {
      price: restingPrice,
    });
  }
  if (!isOnGrid(price, spec.tickSize)) {
    throw new DomainError(
      TradingErrorCode.INVALID_PRICE,
      `Price ${restingPrice} is not a multiple of the ${spec.code} tick size ${spec.tickSize}`,
      { tickSize: spec.tickSize },
    );
  }

  if (shouldTriggerPending(type, side, restingPrice, quote)) {
    const executable = normalizePrice(spec, entryPriceFor(side, quote)).toString();
    const wanted = waitsForFall(type, side) ? 'below' : 'above';
    throw new DomainError(
      TradingErrorCode.INVALID_PRICE,
      `A ${side} ${type} must rest ${wanted} the current executable price of ${executable}; at ${restingPrice} it would fill immediately. Submit a market order if that is what you want.`,
      { side, type, price: restingPrice, executable },
    );
  }
}

/**
 * Protective levels on a resting order are measured against its own resting
 * price, not the current market.
 *
 * The order will open at roughly its resting price, so that is the reference a
 * stop-loss has to sit the right side of. Measuring against the market at
 * placement time would accept a stop that is nonsense by the time the order
 * actually fills.
 */
export function protectiveReferenceFor(restingPrice: string): string {
  return restingPrice;
}

export interface ExpiryInput {
  readonly timeInForce: string;
  readonly expiresAt: number | null;
}

/**
 * Has this order outlived its instruction?
 *
 * GTD carries its own timestamp. DAY is stored the same way — the expiry is
 * computed once, when the order is placed, in the trading server's timezone —
 * so that this check never has to know what a "day" means. GTC never expires.
 */
export function isExpired(order: ExpiryInput, atMs: number): boolean {
  if (order.expiresAt === null) return false;
  return atMs >= order.expiresAt;
}
