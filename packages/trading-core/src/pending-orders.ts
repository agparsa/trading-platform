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
  assertPriceShape(spec, restingPrice);

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

/** Positive and on the instrument's tick grid: what any price an order rests at must be. */
function assertPriceShape(spec: SymbolSpec, value: string): void {
  const price = toDecimal(value);
  if (price.lte(0)) {
    throw new DomainError(TradingErrorCode.INVALID_PRICE, 'Order price must be positive', {
      price: value,
    });
  }
  if (!isOnGrid(price, spec.tickSize)) {
    throw new DomainError(
      TradingErrorCode.INVALID_PRICE,
      `Price ${value} is not a multiple of the ${spec.code} tick size ${spec.tickSize}`,
      { tickSize: spec.tickSize },
    );
  }
}

/**
 * Stop-limit orders.
 *
 * Two prices and two phases. Until the market reaches the **stop**, the order
 * waits exactly as a stop does — on the far side of the market, measured on
 * the executable entry price. Once the stop is reached the order is
 * *activated* and from then on it is a limit at its **limit** price: it fills
 * at that price or better, or it rests until it can. It never becomes a market
 * order, which is the whole difference from a stop.
 *
 * The two prices are not tied to each other. A buy with its limit above its
 * stop caps how far a breakout may be chased (it fills on activation if the
 * ask is still at or under the limit); a buy with its limit below its stop
 * waits for the pull-back after the breakout. Both are orders people place,
 * and the engine needs no rule to tell them apart: after activation each is a
 * limit like any other.
 */
export interface RestingLeg {
  /** How the leg is measured: a stop waits for the far side, a limit for the near. */
  readonly type: PendingOrderType;
  /** The price this leg is waiting for. */
  readonly price: string;
}

export interface RestingOrderShape {
  readonly type: string;
  /** The resting price; for a stop-limit, the limit. */
  readonly price: string | null;
  /** For a stop-limit, the stop. (A plain stop stores its one price in both.) */
  readonly stopPrice: string | null;
  /** For a stop-limit: whether its stop has been reached. */
  readonly activated: boolean;
}

/**
 * What a resting order is waiting for *now*, or `null` for something that is
 * not a resting order the engine can work (a market order, a row missing its
 * price). A stop-limit is a stop on its stop price until activated, and a
 * limit on its limit price after.
 */
export function activeLeg(order: RestingOrderShape): RestingLeg | null {
  if (order.type === 'LIMIT' || order.type === 'STOP') {
    return order.price === null ? null : { type: order.type, price: order.price };
  }
  if (order.type === 'STOP_LIMIT') {
    if (order.activated) {
      return order.price === null ? null : { type: 'LIMIT', price: order.price };
    }
    return order.stopPrice === null ? null : { type: 'STOP', price: order.stopPrice };
  }
  return null;
}

/**
 * Validate a stop-limit's two prices at placement, or while it still waits
 * for its stop.
 *
 * The stop must be a stop that has not been reached — an order whose stop is
 * already behind the market would activate on the next tick, which is a limit
 * order the trader could have placed directly. The limit must be a price an
 * order can rest at; where it sits relative to the stop is the trader's
 * choice (see above).
 */
export function validateStopLimit(
  spec: SymbolSpec,
  side: OrderSide,
  stopPrice: string,
  limitPrice: string,
  quote: Quote,
): void {
  assertPriceShape(spec, stopPrice);
  assertPriceShape(spec, limitPrice);
  if (shouldTriggerPending('STOP', side, stopPrice, quote)) {
    const executable = normalizePrice(spec, entryPriceFor(side, quote)).toString();
    const wanted = waitsForFall('STOP', side) ? 'below' : 'above';
    throw new DomainError(
      TradingErrorCode.INVALID_PRICE,
      `The stop of a ${side} STOP_LIMIT must be ${wanted} the current executable price of ${executable}; at ${stopPrice} it has already been reached. Place a ${side} LIMIT at ${limitPrice} if that is what you want.`,
      { side, type: 'STOP_LIMIT', stopPrice, limitPrice, executable },
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
