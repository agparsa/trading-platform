import { toDecimal, type Decimal } from '@tp/financial-core';
import {
  CheckCode,
  Severity,
  type AccountRecords,
  type AccountReport,
  type Finding,
  type LedgerTotals,
  type PositionRecord,
  type TradeRecord,
} from './types';

/**
 * Every check this engine performs, and nothing that only looks like one.
 *
 * The specification lists ten comparisons. Three of them — an execution with no
 * order, a closing execution with no position, a trade with no position — are
 * not implemented here, and that is the correct outcome rather than an omission:
 * each is a foreign key in this schema. PostgreSQL enforces them on every write,
 * and re-checking them afterwards would be a check that can never fire, which is
 * worse than none. It looks like coverage and costs a query.
 *
 * What is left are the comparisons a database cannot make: sums that must agree,
 * records that must be backed by ledger entries, and a cached balance that must
 * equal a replay of the entries behind it.
 *
 * **Nothing here repairs anything.** Every function returns findings. Correcting
 * financial drift automatically would destroy the evidence of how it happened,
 * which is the one thing an investigation needs.
 */

/** Below this, two decimal strings are the same number. */
function differs(a: Decimal, b: Decimal): boolean {
  return !a.equals(b);
}

function finding(
  code: (typeof CheckCode)[keyof typeof CheckCode],
  severity: Severity,
  expected: Decimal | string,
  actual: Decimal | string,
  message: string,
  subject?: { type: string; id: string },
): Finding {
  const e = toDecimal(expected.toString());
  const a = toDecimal(actual.toString());
  return {
    code,
    severity,
    expected: e.toString(),
    actual: a.toString(),
    difference: a.minus(e).toString(),
    ...(subject === undefined ? {} : { subjectType: subject.type, subjectId: subject.id }),
    message,
  };
}

/**
 * The cached balance against a replay of the ledger.
 *
 * The most serious check here. `accounts.balance` is a cache; `balance_ledger`
 * is the record. If they disagree, something wrote a balance outside the ledger
 * service, and the number a trader is looking at is not backed by an auditable
 * trail.
 */
export function checkLedgerDrift(records: AccountRecords): Finding[] {
  const replayed = toDecimal(records.ledger.all);
  const stored = toDecimal(records.storedBalance);
  if (!differs(replayed, stored)) return [];
  return [
    finding(
      CheckCode.LEDGER_DRIFT,
      Severity.CRITICAL,
      replayed,
      stored,
      `Cached balance ${stored.toString()} does not match a replay of the ledger (${replayed.toString()})`,
      { type: 'Account', id: records.accountId },
    ),
  ];
}

/**
 * A filled order that produced no execution.
 *
 * Scoped to `FILLED` on purpose. A resting order with no execution is not a
 * fault — it is an order waiting for its price — and a check that flagged every
 * pending order would bury the one case that matters in noise nobody reads.
 */
export function checkFilledOrdersHaveExecutions(records: AccountRecords): Finding[] {
  return records.orders
    .filter((order) => order.status === 'FILLED' && order.executionCount === 0)
    .map((order) =>
      finding(
        CheckCode.FILLED_ORDER_WITHOUT_EXECUTION,
        Severity.CRITICAL,
        '1',
        '0',
        `Order ${order.id} is FILLED but has no execution recorded`,
        { type: 'Order', id: order.id },
      ),
    );
}

/** A position that exists without the fill that opened it. */
export function checkPositionsHaveOpeningExecutions(records: AccountRecords): Finding[] {
  return records.positions
    .filter((position) => toDecimal(position.openingExecutedVolume).lte(0))
    .map((position) =>
      finding(
        CheckCode.POSITION_WITHOUT_OPENING_EXECUTION,
        Severity.CRITICAL,
        position.initialVolume,
        '0',
        `Position ${position.id} has no opening execution`,
        { type: 'Position', id: position.id },
      ),
    );
}

/**
 * Open volume against the executions that produced it.
 *
 * `opened − closed` is what the position should still be holding. This is the
 * check that catches a close which wrote a trade but never reduced the position,
 * or a partial fill counted twice.
 */
export function checkPositionVolumes(records: AccountRecords): Finding[] {
  const findings: Finding[] = [];
  for (const position of records.positions) {
    const expected = toDecimal(position.openingExecutedVolume).minus(
      toDecimal(position.closingExecutedVolume),
    );
    const actual = toDecimal(position.volume);
    if (!differs(expected, actual)) continue;
    findings.push(
      finding(
        CheckCode.POSITION_VOLUME_MISMATCH,
        Severity.CRITICAL,
        expected,
        actual,
        `Position ${position.id} holds ${actual.toString()} lots but its executions net to ${expected.toString()}`,
        { type: 'Position', id: position.id },
      ),
    );
  }
  return findings;
}

/**
 * A closed round trip with nothing in the ledger behind it.
 *
 * Every trade moves money — even one whose result rounds to zero, which is why
 * the close path posts a trade-result entry unconditionally. A trade with no
 * entries at all means a balance changed, or failed to, with no record of why.
 */
export function checkTradesHaveLedgerEntries(records: AccountRecords): Finding[] {
  return records.trades
    .filter((trade) => trade.ledgerEntryCount === 0)
    .map((trade) =>
      finding(
        CheckCode.TRADE_WITHOUT_LEDGER_ENTRY,
        Severity.CRITICAL,
        '1',
        '0',
        `Trade ${trade.id} has no ledger entry behind it`,
        { type: 'Trade', id: trade.id },
      ),
    );
}

/**
 * What the trades say the account made, against what the ledger paid it.
 *
 * The two are computed by different code from different tables, and this is the
 * comparison that would have caught the trade report drifting a cent from the
 * postings behind it.
 *
 * Commission is subtracted rather than added because the ledger stores it as a
 * negative entry: `tradeResult + commission + swap` is already the signed sum.
 */
export function checkRealizedPnl(records: AccountRecords): Finding[] {
  if (records.trades.length === 0) return [];
  const reported = sum(records.trades, (trade) => trade.netPnl);
  const posted = toDecimal(records.ledger.tradeResult)
    .plus(toDecimal(records.ledger.commission))
    .plus(toDecimal(records.ledger.swap))
    .plus(openPositionCosts(records.positions));

  if (!differs(reported, posted)) return [];
  return [
    finding(
      CheckCode.REALIZED_PNL_MISMATCH,
      Severity.CRITICAL,
      posted,
      reported,
      `Trades report ${reported.toString()} realized but the ledger paid ${posted.toString()}`,
      { type: 'Account', id: records.accountId },
    ),
  ];
}

/**
 * Costs charged to positions that are still open.
 *
 * Their commission and swap are already in the ledger — charged when the
 * position opened, or accrued since — but no trade row reports them yet, so they
 * have to be added back before the two sides can be compared. Without this, an
 * account holding an open position would show a "mismatch" equal to exactly the
 * costs it had legitimately paid.
 */
function openPositionCosts(positions: readonly PositionRecord[]): Decimal {
  let total = toDecimal(0);
  for (const position of positions) {
    if (position.status !== 'OPEN' && position.status !== 'CLOSING') continue;
    total = total.plus(toDecimal(position.commission)).minus(toDecimal(position.swap));
  }
  return total;
}

/**
 * Commission reported against commission charged.
 *
 * Trades carry the commission for both legs of a closed round trip; open
 * positions carry what was charged at entry. Together they must equal what the
 * ledger took.
 */
export function checkCommission(records: AccountRecords): Finding[] {
  const charged = toDecimal(records.ledger.commission).negated();
  const reported = sum(records.trades, (trade) => trade.commission).plus(
    sumPositions(records.positions, (position) => position.commission),
  );
  if (!differs(charged, reported)) return [];
  return [
    finding(
      CheckCode.COMMISSION_MISMATCH,
      Severity.WARNING,
      charged,
      reported,
      `Records report ${reported.toString()} of commission; the ledger charged ${charged.toString()}`,
      { type: 'Account', id: records.accountId },
    ),
  ];
}

/** The same comparison for swap, which unlike commission can be a credit. */
export function checkSwap(records: AccountRecords): Finding[] {
  const posted = toDecimal(records.ledger.swap);
  const reported = sum(records.trades, (trade) => trade.swap).plus(
    sumPositions(records.positions, (position) => position.swap),
  );
  if (!differs(posted, reported)) return [];
  return [
    finding(
      CheckCode.SWAP_MISMATCH,
      Severity.WARNING,
      posted,
      reported,
      `Records report ${reported.toString()} of swap; the ledger posted ${posted.toString()}`,
      { type: 'Account', id: records.accountId },
    ),
  ];
}

/**
 * Every check, for one account.
 *
 * Ordered by what an investigator should read first: a balance that is not
 * backed by the ledger before a commission total that is a cent out.
 */
export function reconcileAccount(records: AccountRecords): AccountReport {
  return {
    accountId: records.accountId,
    number: records.number,
    findings: [
      ...checkLedgerDrift(records),
      ...checkRealizedPnl(records),
      ...checkFilledOrdersHaveExecutions(records),
      ...checkPositionsHaveOpeningExecutions(records),
      ...checkPositionVolumes(records),
      ...checkTradesHaveLedgerEntries(records),
      ...checkCommission(records),
      ...checkSwap(records),
    ],
  };
}

/** Reconstructs a balance from the ledger's own totals, for a report to show. */
export function replayBalance(ledger: LedgerTotals): string {
  return toDecimal(ledger.all).toString();
}

function sum(trades: readonly TradeRecord[], pick: (trade: TradeRecord) => string): Decimal {
  return trades.reduce((total, trade) => total.plus(toDecimal(pick(trade))), toDecimal(0));
}

function sumPositions(
  positions: readonly PositionRecord[],
  pick: (position: PositionRecord) => string,
): Decimal {
  return positions
    .filter((position) => position.status === 'OPEN' || position.status === 'CLOSING')
    .reduce((total, position) => total.plus(toDecimal(pick(position))), toDecimal(0));
}
