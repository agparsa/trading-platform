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
