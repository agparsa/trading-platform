/**
 * What each kind of report contains, and what it costs to be allowed one.
 *
 * The definitions live here, away from the database and the queue, because
 * three separate things need to agree about them and only one of them runs in
 * a request: the API validates a request against this, the worker builds the
 * file from this, and the panel labels the form from this. A column list that
 * lives in the worker is a column list the API cannot check.
 *
 * ## Permission is per kind, and it is the caller's own
 *
 * A report is a way of reading rows. It must not become a way of reading rows
 * you could not read otherwise — so every kind names the permission its
 * contents would have required on screen, and the answer is checked twice:
 * when the report is requested, and again when the file is downloaded. Twice,
 * because a person's role can change in between, and the file outlives the
 * request that made it.
 */
import { Permission } from '@tp/shared-types';

export const ReportKind = {
  TRADES: 'TRADES',
  LEDGER: 'LEDGER',
  AUDIT: 'AUDIT',
  ORDERS: 'ORDERS',
  POSITIONS: 'POSITIONS',
} as const;
export type ReportKind = (typeof ReportKind)[keyof typeof ReportKind];

export interface ReportDefinition {
  readonly kind: ReportKind;
  /** For the panel, and for the filename. */
  readonly title: string;
  /** One line saying what a row is. Shown on the request form. */
  readonly describes: string;
  /** What reading these rows requires — on screen and in a file alike. */
  readonly permission: Permission;
  readonly columns: readonly string[];
}

/**
 * The `TRADES` columns are the closed-trade blotter's, in its order.
 *
 * Deliberately the same as what the screen shows: a statement that disagrees
 * with the panel about what a trade cost starts an argument nobody can settle.
 */
const TRADES: ReportDefinition = {
  kind: ReportKind.TRADES,
  title: 'Closed trades',
  describes: 'One row per closed trade: entry, exit, costs and net profit.',
  permission: Permission.ACCOUNTS_READ_ANY,
  columns: [
    'trade_id',
    'account_number',
    'symbol',
    'side',
    'volume',
    'entry_price',
    'entry_time',
    'exit_price',
    'exit_time',
    'entry_commission',
    'exit_commission',
    'swap',
    'gross_pnl',
    'net_pnl',
    'currency',
    'close_reason',
  ],
};

/**
 * The `LEDGER` columns carry `balance_after`, which is the point of them.
 *
 * A ledger export without the running balance is a list of amounts somebody
 * has to re-add to check, and re-adding is where the disagreement starts. The
 * platform already stores it on every entry for exactly this reason.
 */
const LEDGER: ReportDefinition = {
  kind: ReportKind.LEDGER,
  title: 'Balance ledger',
  describes: 'One row per ledger entry: what moved, why, and the balance after it.',
  permission: Permission.ACCOUNTS_READ_ANY,
  columns: [
    'entry_id',
    'account_number',
    'created_at',
    'type',
    'amount',
    'balance_after',
    'currency',
    'reference_type',
    'reference_id',
    'description',
  ],
};

/**
 * The audit export, and the reason it is the third kind rather than the fifth.
 *
 * Until this one, every role holding `reports.run` also held the permission
 * every kind needed, so the per-kind check was purely defensive — correct, and
 * deciding nothing. `AUDIT` needs `audit.read`, and **`PLATFORM_OPERATOR` holds
 * `reports.run` without it**. The check now refuses a real request from a real
 * role, which is a better place for it to be than waiting for a role edit to
 * make it matter.
 *
 * The columns are the audit screen's, in its order, for the same reason the
 * trades columns are the blotter's: an export that disagrees with the screen it
 * came from starts an argument nobody can settle.
 *
 * `before` and `after` are JSON, and they are already redacted of anything
 * sensitive when the row is written — see `security.md`. This export adds
 * nothing to them and removes nothing from them, which is the only defensible
 * position for an audit trail: redacting at export would mean the file and the
 * screen disagree about what happened.
 */
const AUDIT: ReportDefinition = {
  kind: ReportKind.AUDIT,
  title: 'Audit trail',
  describes: 'One row per recorded action: who, what, and the before and after.',
  permission: Permission.AUDIT_READ,
  columns: [
    'created_at',
    'actor_id',
    'actor_type',
    'action',
    'resource_type',
    'resource_id',
    'request_id',
    'ip_address',
    'before',
    'after',
  ],
};

/**
 * Orders, windowed on when they were **placed**.
 *
 * ## Which timestamp the window means, and why it is not negotiable
 *
 * An order has several: placed, last changed, expires. Only `created_at` is
 * immutable, and a window must be anchored to something immutable or the
 * report is not reproducible — ask for March on the 1st of April and again on
 * the 1st of May and `updated_at` would have moved rows in and out of a window
 * that did not change. "Every order placed in March" is a sentence an operator
 * can act on; "every order touched in March" is one they cannot.
 *
 * ## What still moves, said plainly rather than hidden
 *
 * The *set* of rows is fixed by that choice. The *contents* are not: an order
 * placed on the 31st and still resting has a `status` and a `filled_volume`
 * that will be different tomorrow. Two exports of the same window can therefore
 * differ, and that is not a defect — it is the difference between "which orders
 * were placed" and "what became of them". Anybody reconciling fills should use
 * the closed-trade report, which is settled by construction.
 *
 * `rejection_code` is here on purpose. A rejected order is the one an operator
 * most often wants to explain, and it is the row that leaves no trade behind to
 * find it by.
 */
const ORDERS: ReportDefinition = {
  kind: ReportKind.ORDERS,
  title: 'Orders',
  describes: 'One row per order placed in the window, whatever became of it.',
  permission: Permission.ACCOUNTS_READ_ANY,
  columns: [
    'order_id',
    'account_number',
    'symbol',
    'side',
    'type',
    'status',
    'time_in_force',
    'volume',
    'filled_volume',
    'price',
    'stop_price',
    'stop_loss',
    'take_profit',
    'created_at',
    'updated_at',
    'expires_at',
    'rejection_code',
    'position_id',
    'client_order_id',
    'external_order_id',
  ],
};

/**
 * Positions, windowed on when they were **opened**.
 *
 * ## Open positions are in the file, and that is the point
 *
 * Windowing on `closed_at` would have been the tidier choice — every row
 * complete, every number settled — and it would quietly answer a different
 * question than the one asked. A position opened in March and still open in
 * June belongs in a March report; leaving it out produces a file that looks
 * complete, balances against nothing, and gives no sign of what is missing.
 * That is this feature's own failure mode, and it is worth refusing twice.
 *
 * So `closed_at` and `close_reason` are empty for a position that is still
 * open. An empty cell says "still open"; an absent row says nothing at all.
 *
 * ## What is deliberately **not** in the file
 *
 * There is no unrealized-profit column. The platform knows `current_price` —
 * the last price the engine marked the position at — and multiplying it out
 * would give a number that is true at the instant the report is built and never
 * again. Printed in a file headed "March" and opened in June it reads as a
 * March figure, which it is not, and nothing on the page would say so.
 *
 * `current_price` itself is included, because a mark somebody can see the date
 * of is evidence; a derived profit figure with no date on it is a trap. What is
 * in the file otherwise is what is *settled* about the position — the money
 * already taken or given: commission, swap, realized profit, margin held.
 */
const POSITIONS: ReportDefinition = {
  kind: ReportKind.POSITIONS,
  title: 'Positions',
  describes: 'One row per position opened in the window, open ones included.',
  permission: Permission.ACCOUNTS_READ_ANY,
  columns: [
    'position_id',
    'account_number',
    'symbol',
    'side',
    'status',
    'volume',
    'initial_volume',
    'entry_price',
    'current_price',
    'stop_loss',
    'take_profit',
    'margin',
    'commission',
    'swap',
    'realized_pnl',
    'currency',
    'opened_at',
    'closed_at',
    'close_reason',
    'external_position_id',
  ],
};

export const REPORT_DEFINITIONS: Readonly<Record<ReportKind, ReportDefinition>> = {
  [ReportKind.TRADES]: TRADES,
  [ReportKind.LEDGER]: LEDGER,
  [ReportKind.AUDIT]: AUDIT,
  [ReportKind.ORDERS]: ORDERS,
  [ReportKind.POSITIONS]: POSITIONS,
};

export const ALL_REPORT_KINDS: readonly ReportKind[] = Object.keys(
  REPORT_DEFINITIONS,
) as ReportKind[];

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && value in REPORT_DEFINITIONS;
}

export function definitionOf(kind: ReportKind): ReportDefinition {
  return REPORT_DEFINITIONS[kind];
}

/**
 * The most rows one report may contain.
 *
 * A bound, not a target. The file is assembled in memory before it is sealed,
 * so an unbounded report is an unbounded allocation in a worker that has other
 * jobs to run — and a firm with a busy year would find that out in production
 * rather than here. A report that hits the cap fails saying so, rather than
 * quietly handing somebody a truncated statement and calling it complete.
 *
 * 250,000 rows of the widest kind here is roughly 40 MB of CSV, which seals,
 * stores and downloads without drama.
 */
export const MAX_REPORT_ROWS = 250_000;

/**
 * The filename a download offers.
 *
 * Deterministic from the report, so two people asking for the same window get
 * files whose names match, and sortable, because an operator ends up with a
 * folder of these.
 */
export function reportFilename(
  kind: ReportKind,
  window: { readonly fromMs: number; readonly toMs: number },
): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return `${kind.toLowerCase()}-${day(window.fromMs)}-to-${day(window.toMs)}.csv`;
}
