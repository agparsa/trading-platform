/**
 * How a resting order is described on the phone, in one line.
 *
 * A stop-limit has two prices and two phases, and "at 4602" alone would say
 * the one thing it is not: an order waiting at 4602. Until its stop is reached
 * it waits for the stop; after, it rests at its limit. Kept out of the screen
 * so the words can be tested.
 */

export interface RestingOrderLine {
  readonly type: string;
  readonly price: string;
  readonly stopPrice?: string | null;
  readonly activatedAt?: string | null;
}

/** "STOP LMT" rather than "STOP_LIMIT": the label, not the enum. */
export function orderTypeLabel(type: string): string {
  return type === 'STOP_LIMIT' ? 'STOP LMT' : type;
}

export function restingPriceLine(order: RestingOrderLine): string {
  if (order.type !== 'STOP_LIMIT' || order.stopPrice == null) return `at ${order.price}`;
  return order.activatedAt == null
    ? `stop ${order.stopPrice}, then limit ${order.price}`
    : `stop reached · resting at limit ${order.price}`;
}
