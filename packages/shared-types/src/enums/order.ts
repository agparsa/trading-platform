export const OrderSide = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP: 'STOP',
  STOP_LIMIT: 'STOP_LIMIT',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

/**
 * Order lifecycle states. Transitions are enforced by the state machine in
 * `@tp/trading-core`; nothing else may mutate `status` directly.
 */
export const OrderStatus = {
  NEW: 'NEW',
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  TRIGGERED: 'TRIGGERED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  MODIFY_REQUESTED: 'MODIFY_REQUESTED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.FILLED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
];

export const TimeInForce = {
  GTC: 'GTC',
  IOC: 'IOC',
  FOK: 'FOK',
  DAY: 'DAY',
  GTD: 'GTD',
} as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

/** What caused an order to move. Recorded on every `order_events` row. */
export const OrderEventType = {
  CREATED: 'CREATED',
  VALIDATED: 'VALIDATED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  TRIGGERED: 'TRIGGERED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  MODIFY_REQUESTED: 'MODIFY_REQUESTED',
  MODIFIED: 'MODIFIED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderEventType = (typeof OrderEventType)[keyof typeof OrderEventType];
