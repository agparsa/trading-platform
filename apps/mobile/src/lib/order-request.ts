import type { OrderSide } from '@tp/shared-types';

/**
 * The body the phone sends to `POST /orders` (and to `/orders/preview`, which
 * takes the same shape), from what is in the ticket's fields.
 *
 * Out of the screen so it can be tested: the defect this module exists to
 * prevent is a field the trader filled in that never reaches the wire — the
 * shape a trailing stop took on its way through the API's own controller.
 */
export interface TicketFields {
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly volume: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly trailingDistance: string;
}

export interface OrderRequest {
  accountId: string;
  symbol: string;
  side: OrderSide;
  volume: string;
  stopLoss: string | null;
  takeProfit: string | null;
  /** Present only when the trader asked for a trail; the server checks the firm's flag only then. */
  trailingStopDistance?: string;
}

export function orderRequest(fields: TicketFields): OrderRequest {
  const text = (value: string) => value.trim();
  const trail = text(fields.trailingDistance);
  return {
    accountId: fields.accountId,
    symbol: fields.symbol,
    side: fields.side,
    volume: text(fields.volume),
    stopLoss: text(fields.stopLoss) === '' ? null : text(fields.stopLoss),
    takeProfit: text(fields.takeProfit) === '' ? null : text(fields.takeProfit),
    ...(trail === '' ? {} : { trailingStopDistance: trail }),
  };
}

/**
 * Whether to offer the trailing field at all.
 *
 * Hidden only when the firm has said no — `trailing_stop` explicitly false.
 * Unknown flags (not loaded, or the request failed) show it, as
 * `mobileTradingDecision` does for trading itself: a preference is not
 * enforced by a failed request, and the server refuses a trail the firm does
 * not allow whatever the phone shows.
 */
export function offersTrailing(features: Readonly<Record<string, boolean>> | undefined): boolean {
  return features?.['trailing_stop'] !== false;
}
