import {
  DomainError,
  OrderStatus,
  TERMINAL_ORDER_STATUSES,
  TradingErrorCode,
} from '@tp/shared-types';

/**
 * The order lifecycle, expressed as data.
 *
 * Nothing in the platform assigns `order.status` directly. Every change goes
 * through `transitionOrder`, so an illegal move — reviving a cancelled order,
 * filling a rejected one — fails loudly at the moment it is attempted rather
 * than corrupting the ledger downstream.
 */
const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.NEW]: [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.REJECTED],
  [OrderStatus.PENDING]: [
    OrderStatus.ACCEPTED,
    OrderStatus.TRIGGERED,
    OrderStatus.MODIFY_REQUESTED,
    OrderStatus.CANCEL_REQUESTED,
    OrderStatus.REJECTED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.ACCEPTED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.MODIFY_REQUESTED,
    OrderStatus.CANCEL_REQUESTED,
    OrderStatus.REJECTED,
    OrderStatus.EXPIRED,
    // Handed to a venue, and the answer was lost. Only from ACCEPTED: an
    // order becomes unconfirmed by being sent, never by being created.
    OrderStatus.UNCONFIRMED,
  ],
  /**
   * The venue's answer, when it finally comes, is one of these. There is no
   * transition back to ACCEPTED: an order whose fate was unknown and is now
   * known is resolved, not un-sent. And there is no self-loop — resending is
   * exactly what must not happen.
   */
  [OrderStatus.UNCONFIRMED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.TRIGGERED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCEL_REQUESTED,
  ],
  [OrderStatus.PARTIALLY_FILLED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.CANCEL_REQUESTED,
    OrderStatus.EXPIRED,
  ],
  // A modify that fails must put the order back where it was; the engine
  // records the prior status alongside the request so it can restore it.
  [OrderStatus.MODIFY_REQUESTED]: [
    OrderStatus.PENDING,
    OrderStatus.ACCEPTED,
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCEL_REQUESTED,
  ],
  // A cancel racing a fill is legitimate: the fill wins, and the cancel is
  // reported as too-late rather than silently dropping the execution.
  [OrderStatus.CANCEL_REQUESTED]: [
    OrderStatus.CANCELLED,
    OrderStatus.FILLED,
    OrderStatus.PARTIALLY_FILLED,
  ],
  [OrderStatus.FILLED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.EXPIRED]: [],
};

export function allowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from];
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Returns `to` when the move is legal, throws otherwise. Callers assign the
 * return value, which makes it impossible to "forget" to check first.
 */
export function transitionOrder(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransitionOrder(from, to)) {
    throw new DomainError(
      TradingErrorCode.INVALID_STATE_TRANSITION,
      `Order cannot move from ${from} to ${to}`,
      { from, to, allowed: ORDER_TRANSITIONS[from].join(',') },
    );
  }
  return to;
}
