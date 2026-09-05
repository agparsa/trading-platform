import type { OrderSide, OrderType, TimeInForce } from '@tp/shared-types';

/**
 * What a connector can do, asked rather than assumed.
 *
 * Every flag is a question the platform would otherwise have to answer by
 * guessing, and a guess about a venue is how an order gets sent somewhere
 * that cannot take it. A connector returns these once, after connecting; the
 * platform stores the snapshot on the connection and consults it before every
 * act — an order type the venue does not support is refused here, with a
 * clear code, rather than sent and rejected there with an opaque one.
 *
 * `false` is the safe default for every flag: a connector that has not looked
 * says it cannot.
 */
export interface BrokerCapabilities {
  readonly supportsMarketOrders: boolean;
  readonly supportsLimitOrders: boolean;
  readonly supportsStopOrders: boolean;
  readonly supportsStopLimitOrders: boolean;
  readonly supportsPartialClose: boolean;
  readonly supportsModifyProtection: boolean;
  /** Both sides open on one instrument at once. */
  readonly supportsHedging: boolean;
  /** The venue pushes quotes; without this the platform must poll. */
  readonly supportsStreamingQuotes: boolean;
  /** The venue pushes fills, closes and rejections; without this the platform must query. */
  readonly supportsOrderEvents: boolean;
  /** Balance, equity and margin can be read from the venue. */
  readonly supportsAccountSync: boolean;
  readonly supportsHistoricalCandles: boolean;
  /** Authenticates with a long-lived API token rather than a password. */
  readonly supportsApiToken: boolean;
  /** The venue can call back with a signed webhook. */
  readonly supportsWebhooks: boolean;
  /** Time-in-force values the venue honours; empty means "market only, immediate". */
  readonly timeInForce: readonly TimeInForce[];
}

export const NO_CAPABILITIES: BrokerCapabilities = Object.freeze({
  supportsMarketOrders: false,
  supportsLimitOrders: false,
  supportsStopOrders: false,
  supportsStopLimitOrders: false,
  supportsPartialClose: false,
  supportsModifyProtection: false,
  supportsHedging: false,
  supportsStreamingQuotes: false,
  supportsOrderEvents: false,
  supportsAccountSync: false,
  supportsHistoricalCandles: false,
  supportsApiToken: false,
  supportsWebhooks: false,
  timeInForce: [],
});

/** Which capability an order type needs. Consulted before an order leaves. */
export function capabilityForOrderType(type: OrderType): keyof BrokerCapabilities {
  switch (type) {
    case 'MARKET':
      return 'supportsMarketOrders';
    case 'LIMIT':
      return 'supportsLimitOrders';
    case 'STOP':
      return 'supportsStopOrders';
    case 'STOP_LIMIT':
      return 'supportsStopLimitOrders';
  }
}

/**
 * The connection's state, as the monitor sees it.
 *
 * UNKNOWN is the honest starting point and the honest answer after a
 * restart: nothing has been heard yet. DEGRADED is connected but late —
 * quotes or heartbeats older than the connection's expectation. AUTH_FAILED
 * and RATE_LIMITED are distinguished from DISCONNECTED because the right
 * response differs: reconnecting with the same credentials makes the first
 * worse, and reconnecting quickly makes the second worse.
 */
export const ConnectionState = {
  UNKNOWN: 'UNKNOWN',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DEGRADED: 'DEGRADED',
  DISCONNECTED: 'DISCONNECTED',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/** What a health check reports. Times are the venue's last sign of life, not ours. */
export interface AdapterHealth {
  readonly state: ConnectionState;
  readonly latencyMs: number | null;
  readonly lastQuoteAt: Date | null;
  readonly lastOrderEventAt: Date | null;
  readonly detail: string | null;
}

/**
 * What a connector is given to authenticate with.
 *
 * Opaque to the platform: the sealed row is opened into this shape only for
 * the call that needs it and never logged. `kind` is what the panel shows;
 * `fields` is what the venue wants — an API token, a login triple, a
 * certificate — and only the connector for that venue knows the keys.
 */
export interface BrokerCredentials {
  readonly kind: BrokerCredentialKind;
  readonly fields: Readonly<Record<string, string>>;
}

export const BrokerCredentialKind = {
  API_TOKEN: 'API_TOKEN',
  API_KEY_SECRET: 'API_KEY_SECRET',
  LOGIN_PASSWORD_SERVER: 'LOGIN_PASSWORD_SERVER',
  CERTIFICATE: 'CERTIFICATE',
} as const;
export type BrokerCredentialKind = (typeof BrokerCredentialKind)[keyof typeof BrokerCredentialKind];

/** An instrument as the venue names it. Mapping onto the platform's symbols is phase 3. */
export interface BrokerInstrument {
  readonly externalSymbol: string;
  readonly description: string;
  readonly quoteCurrency: string;
  readonly contractSize: string;
  readonly volumeStep: string;
  readonly minVolume: string;
  readonly maxVolume: string;
  readonly priceDecimals: number;
  readonly tradable: boolean;
}

export interface BrokerQuote {
  readonly externalSymbol: string;
  readonly bid: string;
  readonly ask: string;
  readonly at: Date;
}

/** Account figures as the venue reports them; strings, never floats. */
export interface BrokerAccountSnapshot {
  readonly externalAccountId: string;
  readonly currency: string;
  readonly balance: string;
  readonly equity: string;
  readonly usedMargin: string;
  readonly freeMargin: string;
  readonly at: Date;
}

/**
 * The order the platform hands over, already validated and normalised.
 *
 * `clientOrderId` is the platform's own id and is the whole of the
 * idempotency story: a venue that supports it will refuse a duplicate, and a
 * venue that does not is queried by it before anything is retried.
 */
export interface NormalisedOrder {
  readonly clientOrderId: string;
  readonly externalAccountId: string;
  readonly externalSymbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly volume: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly timeInForce: TimeInForce;
}

/**
 * What happened to an order, from the venue's point of view.
 *
 * UNKNOWN is a first-class outcome, not an error: the request left and no
 * answer came back within the budget. The platform records it and asks
 * again with `queryOrder`; it never sends the order twice on the strength of
 * a timeout, because the venue may have filled the first one.
 */
export const OrderOutcome = {
  FILLED: 'FILLED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type OrderOutcome = (typeof OrderOutcome)[keyof typeof OrderOutcome];

export interface BrokerFill {
  readonly externalExecutionId: string;
  readonly volume: string;
  readonly price: string;
  readonly at: Date;
  readonly commission: string | null;
}

export interface OrderResult {
  readonly outcome: OrderOutcome;
  readonly clientOrderId: string;
  readonly externalOrderId: string | null;
  readonly externalPositionId: string | null;
  readonly fills: readonly BrokerFill[];
  /** The venue's reason, verbatim, when it gave one. Shown to staff, not to traders. */
  readonly reason: string | null;
}

export interface BrokerPosition {
  readonly externalPositionId: string;
  readonly externalAccountId: string;
  readonly externalSymbol: string;
  readonly side: OrderSide;
  readonly volume: string;
  readonly entryPrice: string;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly openedAt: Date;
}

export interface BrokerOrder {
  readonly externalOrderId: string;
  readonly clientOrderId: string | null;
  readonly externalAccountId: string;
  readonly externalSymbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly volume: string;
  readonly filledVolume: string;
  readonly price: string | null;
  readonly status: 'WORKING' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  readonly at: Date;
}

/**
 * Something the venue tells us unprompted.
 *
 * `externalEventId` is the dedupe key and `sequence` the ordering key: a
 * venue that redelivers, or delivers late, is the normal case, and the
 * inbox (phase 3) keys on the first and sorts by the second. An event with
 * neither is a venue the platform cannot safely listen to, and the connector
 * must say so in its capabilities rather than invent ids.
 */
export interface BrokerEvent {
  readonly externalEventId: string;
  readonly sequence: number | null;
  readonly at: Date;
  readonly kind: BrokerEventKind;
  readonly externalAccountId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const BrokerEventKind = {
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  POSITION_OPENED: 'POSITION_OPENED',
  POSITION_MODIFIED: 'POSITION_MODIFIED',
  POSITION_CLOSED: 'POSITION_CLOSED',
  BALANCE_CHANGED: 'BALANCE_CHANGED',
  CONNECTION_LOST: 'CONNECTION_LOST',
  CONNECTION_RESTORED: 'CONNECTION_RESTORED',
} as const;
export type BrokerEventKind = (typeof BrokerEventKind)[keyof typeof BrokerEventKind];

/**
 * The one error type a connector throws. `code` is what the platform acts
 * on; `retryable` is the connector's own judgement of whether asking again
 * could help, which the circuit breaker weighs but does not trust blindly.
 */
export class BrokerAdapterError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    readonly retryable: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrokerAdapterError';
  }
}

export const BrokerErrorCode = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  UNSUPPORTED: 'UNSUPPORTED',
  UNKNOWN_INSTRUMENT: 'UNKNOWN_INSTRUMENT',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  UNKNOWN_ORDER: 'UNKNOWN_ORDER',
  UNKNOWN_POSITION: 'UNKNOWN_POSITION',
  VENUE_REJECTED: 'VENUE_REJECTED',
  VENUE_ERROR: 'VENUE_ERROR',
} as const;
export type BrokerErrorCode = (typeof BrokerErrorCode)[keyof typeof BrokerErrorCode];
