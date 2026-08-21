import type { AccountStateDto, CandleDto, DecimalString, EpochMillis, QuoteDto } from './wire';

/**
 * WebSocket event names. The browser never polls for trading state — every
 * value on screen arrives through one of these.
 */
export const WsEvent = {
  QUOTE_UPDATE: 'quote.update',
  CANDLE_UPDATE: 'candle.update',

  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_FILLED: 'order.filled',
  ORDER_CANCELLED: 'order.cancelled',

  POSITION_CREATED: 'position.created',
  POSITION_UPDATED: 'position.updated',
  POSITION_CLOSED: 'position.closed',

  ACCOUNT_UPDATED: 'account.updated',
  PNL_UPDATED: 'pnl.updated',
  MARGIN_UPDATED: 'margin.updated',
} as const;
export type WsEvent = (typeof WsEvent)[keyof typeof WsEvent];

/** Subscribable channels. Private channels are scoped to the authenticated account. */
export const WsChannel = {
  QUOTES: 'quotes',
  CANDLES: 'candles',
  ORDERS: 'orders',
  POSITIONS: 'positions',
  ACCOUNT: 'account',
  PNL: 'pnl',
} as const;
export type WsChannel = (typeof WsChannel)[keyof typeof WsChannel];

export const PUBLIC_CHANNELS: readonly WsChannel[] = [WsChannel.QUOTES, WsChannel.CANDLES];

export interface WsEnvelope<E extends WsEvent, D> {
  event: E;
  data: D;
  /**
   * Monotonic per-connection sequence number. A client that sees a gap knows it
   * missed a frame and must re-snapshot rather than silently drift.
   */
  seq: number;
  timestamp: EpochMillis;
}

export interface PnlUpdatePayload {
  accountId: string;
  positionId: string;
  symbol: string;
  floatingPnl: DecimalString;
  currentPrice: DecimalString;
}

export type WsMessage =
  | WsEnvelope<typeof WsEvent.QUOTE_UPDATE, QuoteDto>
  | WsEnvelope<typeof WsEvent.CANDLE_UPDATE, CandleDto>
  | WsEnvelope<typeof WsEvent.ACCOUNT_UPDATED, AccountStateDto>
  | WsEnvelope<typeof WsEvent.PNL_UPDATED, PnlUpdatePayload>;

/**
 * Internal domain events published on the event bus (Redis pub/sub + BullMQ).
 * These are the integration seam a future PropFA product subscribes to — it
 * must never reach into this system's tables.
 */
export const DomainEvent = {
  ORDER_CREATED: 'order.created',
  ORDER_ACCEPTED: 'order.accepted',
  ORDER_REJECTED: 'order.rejected',
  ORDER_FILLED: 'order.filled',
  ORDER_CANCELLED: 'order.cancelled',
  POSITION_OPENED: 'position.opened',
  POSITION_MODIFIED: 'position.modified',
  POSITION_CLOSED: 'position.closed',
  BALANCE_CHANGED: 'balance.changed',
  MARGIN_CALL: 'margin.call',
  LIQUIDATION: 'liquidation',
} as const;
export type DomainEvent = (typeof DomainEvent)[keyof typeof DomainEvent];
