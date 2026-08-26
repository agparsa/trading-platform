import type { OrderSide } from '@tp/shared-types';

export interface OpenPositionRequest {
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  /** Volume in lots, as a decimal string. */
  readonly volume: string;
  readonly stopLoss?: string | null;
  readonly takeProfit?: string | null;
}

export interface ClosePositionRequest {
  readonly positionId: string;
  /** Omitted or null closes the whole position. */
  readonly volume?: string | null;
}

export interface ModifyPositionRequest {
  readonly positionId: string;
  /** `undefined` leaves the level alone; `null` removes it. */
  readonly stopLoss?: string | null;
  readonly takeProfit?: string | null;
  readonly trailingStopDistance?: string | null;
}

export interface OrderResult {
  orderId: string;
  positionId: string | null;
  status: string;
  symbol: string;
  side: OrderSide;
  volume: string;
  price: string;
  executedAt: string;
}

export interface CloseResult {
  positionId: string;
  closedVolume: string;
  remainingVolume: string;
  exitPrice: string;
  grossPnl: string;
  /** Opening-leg commission apportioned to the closed volume. */
  entryCommission: string;
  /** Closing-leg commission, the only one this close charges. */
  exitCommission: string;
  /** entryCommission + exitCommission. */
  commission: string;
  swap: string;
  /** grossPnl - commission + swap: the round trip's contribution to balance. */
  netPnl: string;
  balanceAfter: string;
  closeReason: string;
  fullyClosed: boolean;
}

export interface PlacePendingRequest {
  readonly accountId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  /** LIMIT rests on the favourable side of the market, STOP on the far side. */
  readonly type: 'LIMIT' | 'STOP';
  readonly volume: string;
  /** The price the order rests at, as a decimal string. */
  readonly price: string;
  readonly stopLoss?: string | null;
  readonly takeProfit?: string | null;
  /** GTC rests indefinitely, DAY until the next trading-server midnight, GTD until `expiresAt`. */
  readonly timeInForce?: 'GTC' | 'DAY' | 'GTD';
  /** Required for GTD, ignored otherwise. Epoch milliseconds. */
  readonly expiresAt?: number | null;
}

export interface ModifyPendingRequest {
  readonly orderId: string;
  /** `undefined` leaves a field alone; `null` clears a protective level. */
  readonly price?: string;
  readonly volume?: string;
  readonly stopLoss?: string | null;
  readonly takeProfit?: string | null;
}

export interface PendingOrderResult {
  orderId: string;
  status: string;
  symbol: string;
  side: OrderSide;
  type: string;
  volume: string;
  price: string;
  stopLoss: string | null;
  takeProfit: string | null;
  timeInForce: string;
  expiresAt: string | null;
  createdAt: string;
}
