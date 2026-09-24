import type { AccountStateDto, CandleDto, DecimalString, EpochMillis, QuoteDto } from './wire';

/**
 * WebSocket event names. The browser never polls for trading state — every
 * value on screen arrives through one of these.
 */
export const WsEvent = {
  /**
   * Every instrument that moved since the last frame, in one frame.
   *
   * Quotes are *conflated*: the gateway keeps the newest quote per symbol and
   * sends what changed every `QUOTE_FANOUT_INTERVAL_MS` (default 100 ms), so a
   * socket receives at most ten quote frames a second however fast the feed
   * ticks. The number on screen is never older than the interval; the number an
   * order fills at is never this one — the engine prices from its own fresh
   * quote. Before this, one frame per tick per socket was the whole of the
   * serving instance's CPU at a thousand sockets.
   */
  QUOTES_UPDATED: 'quotes.updated',
  CANDLE_UPDATE: 'candle.update',

  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_FILLED: 'order.filled',
  ORDER_CANCELLED: 'order.cancelled',
  /**
   * A resting order the engine refused when it triggered — nearly always
   * because the account could not carry it by the time the market got there.
   *
   * This used to be delivered as `order.updated`, which is how a client learns
   * that *something* about an order changed and nothing about what. A trader
   * whose breakout order was refused for margin has to be told that, in those
   * words: an order that quietly stops existing is worse than one that fails
   * loudly, and "updated" is the quiet version.
   */
  ORDER_REJECTED: 'order.rejected',

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
  /**
   * Every open position's floating figure, in one frame per valuation.
   *
   * Computed together from one valuation at one price, and sent together:
   * a frame per position was thirteen frames per socket per valuation at a
   * thousand traders, and the serving instance spent itself serialising them.
   */
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

/**
 * One open position's figures in a `pnl.updated` frame.
 *
 * This interface said `currentPrice: DecimalString` and had no `netPnl` or
 * `stale` for as long as the server has sent them — nothing compiled against
 * it. The server's frame now `satisfies` it, and `pnpm smoke:contracts` holds
 * the clients' reading of the real frame to their own types.
 */
export interface PnlUpdatePayload {
  accountId: string;
  positionId: string;
  symbol: string;
  floatingPnl: DecimalString;
  /** The floating figure less the costs already charged. Computed by the server, never a client. */
  netPnl: DecimalString;
  /** `null` when no fresh price exists — never a stale one presented as current. */
  currentPrice: DecimalString | null;
  stale: boolean;
}

/** `order.filled`: the order, and the position its fill became. */
export interface OrderFilledPayload {
  orderId: string;
  /** `null` when a venue filled an order this platform could not yet match to a position. */
  positionId: string | null;
  symbol: string;
  side: string;
  volume: DecimalString;
  /** `null` when a venue reported the fill without an average price. */
  price: DecimalString | null;
}

/**
 * `order.cancelled` and `order.rejected`: the order is not coming, and why.
 * `reason` is `MANUAL` or `EXPIRED` for a cancellation and the refusal in
 * words for a rejection; `code` is the refusal's error code, when there is one.
 */
export interface OrderEndedPayload {
  orderId: string;
  symbol: string;
  reason: string;
  code?: string;
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

/**
 * A frame as a client receives it, before it has looked at `event`.
 *
 * `data` is `unknown` because what it is depends on `event` — a list of quotes
 * for one, an account for another. The web typed it `Record<string, unknown>`,
 * which two of its events are not, and the phone named the timestamp `at`,
 * which the server has never sent. Both now use this.
 */
export type WsFrame = WsEnvelope<WsEvent, unknown>;

export type WsMessage =
  | WsEnvelope<typeof WsEvent.QUOTES_UPDATED, QuoteDto[]>
  | WsEnvelope<typeof WsEvent.CANDLE_UPDATE, CandleDto>
  | WsEnvelope<typeof WsEvent.ACCOUNT_UPDATED, AccountStateDto>
  | WsEnvelope<typeof WsEvent.PNL_UPDATED, PnlUpdatePayload[]>;

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

/**
 * Events the outbox carries that are not about an order, a position or a
 * balance (§49).
 *
 * A `DomainEvent` describes something a trader did or something the engine did
 * to their money, and every one of them is written by the request that caused
 * it. These two are different in kind: they are the platform noticing something
 * *about itself*, and they are produced by the audit writer and the
 * reconciliation sweep rather than by trading.
 *
 * They are kept in their own object rather than added to `DomainEvent` because
 * the domain-event list is also the socket's vocabulary and the PropFA seam's
 * contract, and neither of those wants a failed sign-in. What both lists share
 * is the outbox, so `OUTBOX_EVENT_TYPES` is the union and that is what a
 * webhook endpoint may subscribe to.
 */
export const PlatformEvent = {
  /**
   * A reconciliation finding raised for the first time, or one that had been
   * closed and has come back. Deliberately **not** every recurrence: a drift
   * that is still there an hour later is the same fact, and an hourly sweep
   * would send it seven hundred times in a month and bury the next real one.
   */
  RECONCILIATION_MISMATCH: 'reconciliation.mismatch',
  /**
   * A security event the platform rates WARNING — a failed sign-in, a new
   * device, a second factor switched off, a break-glass, an IP rule changed.
   * INFO and NOTICE are not sent: a webhook for every successful sign-in is a
   * denial-of-service against the receiver and against whoever reads it.
   */
  SECURITY_ALERT: 'security.alert',
} as const;
export type PlatformEvent = (typeof PlatformEvent)[keyof typeof PlatformEvent];

/**
 * Every event type the outbox can carry, and so every type a webhook endpoint
 * may name. An endpoint that names none gets all of these, including the ones
 * added after it was registered.
 */
export const OUTBOX_EVENT_TYPES: readonly string[] = [
  ...Object.values(DomainEvent),
  ...Object.values(PlatformEvent),
];
