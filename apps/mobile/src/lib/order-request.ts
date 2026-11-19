import type { OrderSide } from '@tp/shared-types';
import { english, type Translate } from './messages';

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
  t: Translate = english,
): string | null {
  if (kind === 'MARKET') return null;
  const check = (value: string, which: 'stop' | 'limit'): string | null => {
    const name = t(which === 'stop' ? 'ticket.name.stop' : 'ticket.name.limit');
    const trimmed = value.trim();
    if (trimmed === '') return t('ticket.enter', { name });
    if (!DECIMAL.test(trimmed)) return t('ticket.number', { name });
    return null;
  };
  if (kind === 'STOP_LIMIT') {
    return check(stopPrice, 'stop') ?? check(price, 'limit');
  }
  return check(price, kind === 'LIMIT' ? 'limit' : 'stop');
}

/** The order in one sentence, for the confirmation. */
export function restingSummary(request: RestingRequest, t: Translate = english): string {
  const where =
    request.type === 'STOP_LIMIT'
      ? t('orders.stopThenLimit', { stop: request.stopPrice ?? '—', price: request.price })
      : t('orders.at', { price: request.price });
  return t('ticket.restingSummary', {
    side: t(request.side === 'BUY' ? 'common.BUY' : 'common.SELL'),
    volume: request.volume,
    symbol: request.symbol,
    kind: t(`orders.kind.${request.type}`).toLowerCase(),
    where,
    until: request.timeInForce === 'DAY' ? t('ticket.untilDay') : t('ticket.untilCancelled'),
  });
}
