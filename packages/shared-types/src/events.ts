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

  /**
   * Balance, equity, floating P&L, used margin, free margin and margin level —
   * all in one frame, deliberately.
   *
   * The specification asks for `MarginUpdated` and `FreeMarginUpdated` as
   * separate streams. They are not separate here, because those figures are
   * derived from each other: free margin *is* equity minus used margin. Split
   * across frames, a client that applies one and not yet the other renders a set
   * of numbers that never existed — an equity from 10:00:00.250 beside a used
   * margin from 10:00:00.750, and a free margin that matches neither.
   *
   * One frame carrying a consistent set is a stronger guarantee than four
   * frames carrying the same information, and it is a quarter of the traffic.
   */
  ACCOUNT_UPDATED: 'account.updated',
  PNL_UPDATED: 'pnl.updated',
  /**
   * The account crossed into or out of a risk state — margin call, stop-out
   * proximity, or back to normal.
   *
   * Emitted **on transition only**, never per tick. A margin level that sits at
   * 94% for an hour produces one frame, not fourteen thousand. That is what
   * makes it safe for a notification to be raised directly from it.
   */
  RISK_UPDATED: 'risk.updated',
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
  /**
   * Identifies the *occurrence*, not the delivery.
   *
   * Two frames carrying the same `eventId` describe one thing that happened
   * once, and a client may discard the second. That is not a theoretical
   * nicety: until this was added, every domain event was delivered twice — the
   * gateway subscribes to Redis, `EventsService` publishes to Redis as well as
   * to its local handlers, and Redis hands a message back to the connection
   * that sent it. The duplicate is now suppressed at the source, and this field
   * is what lets a client prove it.
   *
   * Public frames (quotes, candles) mint one per frame; they have no upstream
   * occurrence to identify.
   */
  eventId: string;
  data: D;
  /** Which subscription produced this frame. */
  channel: WsChannel;
  /** The account this frame concerns, or `null` for public market data. */
  accountId: string | null;
  /**
   * Monotonic per-connection sequence number. A client that sees a gap knows it
   * missed a frame and must re-snapshot rather than silently drift.
   *
   * Per *connection*, which is the stream a client actually reads. A per-channel
   * counter would let a client detect a gap in quotes without noticing one in
   * positions; one counter across the socket means any loss at all is visible.
   * It resets on reconnect, which is why the reconnect contract re-snapshots
   * rather than resuming.
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

/**
 * How close an account is to the levels that stop it trading.
 *
 * Ordered by severity so a transition can be compared rather than pattern
 * matched: `NORMAL < MARGIN_CALL < STOP_OUT`.
 */
export const RiskState = {
  NORMAL: 'NORMAL',
  MARGIN_CALL: 'MARGIN_CALL',
  STOP_OUT: 'STOP_OUT',
} as const;
export type RiskState = (typeof RiskState)[keyof typeof RiskState];

export interface RiskUpdatePayload {
  accountId: string;
  state: RiskState;
  previous: RiskState;
  /** Null when no margin is used — not Infinity, not zero. */
  marginLevel: DecimalString | null;
  marginCallLevelPercent: DecimalString | null;
  stopOutLevelPercent: DecimalString | null;
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
