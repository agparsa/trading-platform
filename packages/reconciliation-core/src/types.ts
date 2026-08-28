/**
 * The records reconciliation compares, and what it says when they disagree.
 *
 * Everything here is a plain shape with decimal *strings*, deliberately not the
 * Prisma row types. The checks are arithmetic about money and must be testable
 * against a hand-built fixture with a cent deliberately wrong in it — which is
 * impossible if running one requires a database.
 */

export const Severity = {
  /** Worth knowing. Nothing is provably wrong with the money. */
  INFO: 'INFO',
  /** Something does not add up and a human should look. */
  WARNING: 'WARNING',
  /** A balance or a trade record is not backed by the ledger. */
  CRITICAL: 'CRITICAL',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const CheckCode = {
  FILLED_ORDER_WITHOUT_EXECUTION: 'FILLED_ORDER_WITHOUT_EXECUTION',
  POSITION_WITHOUT_OPENING_EXECUTION: 'POSITION_WITHOUT_OPENING_EXECUTION',
  POSITION_VOLUME_MISMATCH: 'POSITION_VOLUME_MISMATCH',
  TRADE_WITHOUT_LEDGER_ENTRY: 'TRADE_WITHOUT_LEDGER_ENTRY',
  LEDGER_DRIFT: 'LEDGER_DRIFT',
  REALIZED_PNL_MISMATCH: 'REALIZED_PNL_MISMATCH',
  COMMISSION_MISMATCH: 'COMMISSION_MISMATCH',
  SWAP_MISMATCH: 'SWAP_MISMATCH',
  EQUITY_MISMATCH: 'EQUITY_MISMATCH',
} as const;
export type CheckCode = (typeof CheckCode)[keyof typeof CheckCode];

export interface Finding {
  readonly code: CheckCode;
  readonly severity: Severity;
  /** What was expected, what was found, and by how much they differ. */
  readonly expected: string;
  readonly actual: string;
  readonly difference: string;
  /** The row this is about, when it is about one row. */
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly message: string;
}

export interface OrderRecord {
  id: string;
  status: string;
  volume: string;
  filledVolume: string;
  positionId: string | null;
  executionCount: number;
}

export interface PositionRecord {
  id: string;
  status: string;
  volume: string;
  initialVolume: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  /** Executions across every order that belongs to this position. */
  openingExecutedVolume: string;
  closingExecutedVolume: string;
}

export interface TradeRecord {
  id: string;
  positionId: string;
  grossPnl: string;
  commission: string;
  entryCommission: string;
  exitCommission: string;
  swap: string;
  netPnl: string;
  /** Ledger entries referencing this trade's position, summed by kind. */
  ledgerEntryCount: number;
}

export interface LedgerTotals {
  /** Signed sum of every entry. */
  all: string;
  /** Signed sum of TRADE_PROFIT and TRADE_LOSS. */
  tradeResult: string;
  /** Signed sum of COMMISSION entries — negative, since commission is a charge. */
  commission: string;
  /** Signed sum of SWAP entries. */
  swap: string;
}

export interface AccountRecords {
  accountId: string;
  number: string;
  currency: string;
  /** The cached balance on the account row. */
  storedBalance: string;
  ledger: LedgerTotals;
  orders: readonly OrderRecord[];
  positions: readonly PositionRecord[];
  trades: readonly TradeRecord[];
}

export interface AccountReport {
  accountId: string;
  number: string;
  findings: readonly Finding[];
}
