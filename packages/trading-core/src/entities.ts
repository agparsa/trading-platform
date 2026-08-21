import type {
  CloseReason,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionStatus,
  TimeInForce,
} from '@tp/shared-types';

/**
 * Domain entities.
 *
 * These are plain, framework-free shapes. Monetary and price fields are decimal
 * strings so the domain never depends on a Decimal instance crossing a boundary;
 * `@tp/financial-core` turns them into `Decimal`/`Money` at the point of
 * calculation. Persistence maps them to NUMERIC columns.
 */
export interface OrderEntity {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly timeInForce: TimeInForce;
  /** Requested volume in lots. */
  readonly volume: string;
  /** Volume filled so far; equals `volume` once status is FILLED. */
  readonly filledVolume: string;
  /** Limit or stop price. Null for a market order. */
  readonly price: string | null;
  /** Second price for STOP_LIMIT: the limit placed once the stop triggers. */
  readonly stopPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** Position this order opens or closes. Null until an opening order fills. */
  readonly positionId: string | null;
  /** Optimistic-concurrency token. Every mutation must bump it. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
}

export interface PositionEntity {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly status: PositionStatus;
  /** Currently open volume in lots; decreases on a partial close. */
  readonly volume: string;
  /** Volume at open, retained so partial-close history stays reconstructable. */
  readonly initialVolume: string;
  readonly entryPrice: string;
  /** Executable exit price at the last valuation. Null before the first tick. */
  readonly currentPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** Distance in price units for a trailing stop, or null when not trailing. */
  readonly trailingStopDistance: string | null;
  /** Best price seen since open — the anchor a trailing stop follows. */
  readonly highWaterPrice: string | null;
  /** Initial margin held, in account currency. */
  readonly margin: string;
  readonly commission: string;
  readonly swap: string;
  readonly realizedPnl: string;
  readonly closeReason: CloseReason | null;
  readonly version: number;
  readonly openedAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

export interface ExecutionEntity {
  readonly id: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly volume: string;
  readonly price: string;
  /** Quote the engine executed against, retained for dispute resolution. */
  readonly quoteBid: string;
  readonly quoteAsk: string;
  readonly executedAt: Date;
}
