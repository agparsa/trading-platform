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

/**
 * What the phone's ticket can place. `MARKET` goes to `POST /orders`; the
 * other three rest, through `POST /orders/pending`.
 */
export type OrderKind = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

/** What each kind is called on a button, and in the confirmation. */
export const ORDER_KIND_LABEL: Readonly<Record<OrderKind, string>> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  STOP: 'Stop',
  STOP_LIMIT: 'Stop-limit',
};

/**
 * The kinds to offer. A stop-limit is left out only when the firm has said
 * no (`stop_limit` explicitly false), for the reason `offersTrailing` gives:
 * unknown flags show it, and the server refuses one the firm does not allow.
 */
export function offeredOrderKinds(
  features: Readonly<Record<string, boolean>> | undefined,
): OrderKind[] {
  const kinds: OrderKind[] = ['MARKET', 'LIMIT', 'STOP'];
  if (features?.['stop_limit'] !== false) kinds.push('STOP_LIMIT');
  return kinds;
}

export interface RestingFields extends TicketFields {
  readonly kind: Exclude<OrderKind, 'MARKET'>;
  /** The resting price; for a stop-limit, its limit. */
  readonly price: string;
  /** A stop-limit's stop. Ignored for the other kinds. */
  readonly stopPrice: string;
  readonly timeInForce: 'GTC' | 'DAY';
}

export interface RestingRequest extends OrderRequest {
  type: Exclude<OrderKind, 'MARKET'>;
  price: string;
  /** Only on a stop-limit: the API refuses it on any other type. */
  stopPrice?: string;
  timeInForce: 'GTC' | 'DAY';
}

/** The body for `POST /orders/pending`: the market body plus where it rests. */
export function restingOrderRequest(fields: RestingFields): RestingRequest {
  return {
    ...orderRequest(fields),
    type: fields.kind,
    price: fields.price.trim(),
    ...(fields.kind === 'STOP_LIMIT' ? { stopPrice: fields.stopPrice.trim() } : {}),
    timeInForce: fields.timeInForce,
  };
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * What is missing before a resting order can be reviewed, in words, or
 * `null`. Only the shape: which side of the market each price must be on is
 * the server's rule, and its refusal says so in its own words when the order
 * is placed — a second copy of that rule here would be a second thing to keep
 * in step with the engine.
 */
export function restingFieldsProblem(
  kind: OrderKind,
  price: string,
  stopPrice: string,
): string | null {
  if (kind === 'MARKET') return null;
  const check = (value: string, name: string): string | null => {
    const trimmed = value.trim();
    if (trimmed === '') return `Enter the ${name}.`;
    if (!DECIMAL.test(trimmed)) return `The ${name} must be a number.`;
    return null;
  };
  if (kind === 'STOP_LIMIT') {
    return check(stopPrice, 'stop price') ?? check(price, 'limit price');
  }
  return check(price, kind === 'LIMIT' ? 'limit price' : 'stop price');
}

/** The order in one sentence, for the confirmation. */
export function restingSummary(request: RestingRequest): string {
  const where =
    request.type === 'STOP_LIMIT'
      ? `stop ${request.stopPrice ?? '—'}, then limit ${request.price}`
      : `at ${request.price}`;
  return `${request.side} ${request.volume} ${request.symbol} ${ORDER_KIND_LABEL[request.type].toLowerCase()} ${where}, ${request.timeInForce === 'DAY' ? 'until the end of the trading day' : 'until cancelled'}.`;
}
