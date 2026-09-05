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

/**
 * What a close-all actually did.
 *
 * Not atomic, and the shape says so: each close takes its own lock, quote and
 * ledger entry, so some can succeed while others do not. Reporting per
 * position is the honest alternative to a boolean that would have to lie.
 */
export interface CloseAllResult {
  /** How many were open when the command was accepted. */
  asked: number;
  closed: CloseResult[];
  /** The ones still open, each with the reason it could not be closed. */
  refused: { positionId: string; code: string; message: string }[];
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

/**
 * What a trader would be committing to, before they commit to it.
 *
 * §14 asks the order ticket to show the estimated commission and margin before
 * submission. The figures come from the server, computed by the same functions
 * that will execute the order, because the alternative — reimplementing margin
 * and commission in the client — is money arithmetic in JavaScript floats on
 * three platforms that will drift apart.
 */
export interface OrderPreview {
  readonly symbol: string;
  readonly side: OrderSide;
  /** After snapping down to the lot grid, which is what will actually trade. */
  readonly volume: string;
  /** The side of the spread this order would cross. */
  readonly price: string;
  readonly bid: string;
  readonly ask: string;
  readonly spread: string;
  readonly notional: string;
  readonly requiredMargin: string;
  readonly estimatedCommission: string;
  readonly accountCurrency: string;

  /** Free margin as it stands, and what would be left. */
  readonly freeMarginBefore: string;
  readonly freeMarginAfter: string;
  readonly marginLevelAfter: string | null;

  /**
   * Whether risk would allow it **at this instant**.
   *
   * An estimate, and deliberately labelled as one. The real check runs inside
   * the transaction, under the account lock, because a check outside the lock
   * is a check of a number that can change before it is used — see
   * `OrdersService.openPosition`. Two orders that each preview as fine can
   * still not both fit.
   */
  readonly wouldBeAccepted: boolean;
  readonly violations: readonly string[];
  /** Anything the trader should read before pressing the button. */
  readonly warnings: readonly string[];
}
