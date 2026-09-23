import { toDecimal } from '@tp/financial-core';

/**
 * Comparing what this platform believes against what a venue says (§44).
 *
 * Different in kind from `checks.ts`, which compares the platform's own records
 * against each other. There, a disagreement means exactly one of our code paths
 * is wrong and the others are the evidence. Here, a disagreement can also mean
 * the venue is right and we are behind, or that we asked at a moment the venue
 * was mid-write. So nothing in this file concludes anything about *cause*: it
 * states what each side said and how they differ, and a person decides.
 *
 * Everything is decimal strings and plain shapes, so a fixture with a cent
 * deliberately wrong in it can be run without a database or a broker.
 */

/** The statuses §44 names, and nothing else. */
export const ItemStatus = {
  MATCHED: 'MATCHED',
  /** The venue has it and we do not. */
  MISSING_INTERNAL: 'MISSING_INTERNAL',
  /** We have it and the venue does not. */
  MISSING_EXTERNAL: 'MISSING_EXTERNAL',
  QUANTITY_MISMATCH: 'QUANTITY_MISMATCH',
  PRICE_MISMATCH: 'PRICE_MISMATCH',
  FEE_MISMATCH: 'FEE_MISMATCH',
  BALANCE_MISMATCH: 'BALANCE_MISMATCH',
  /**
   * Both sides have it and the comparison could not be made — a field the venue
   * left empty, a value that is not a number, a status this platform has no
   * mapping for.
   *
   * Deliberately not "matched". An item nobody could compare is not an item
   * that agrees, and calling it one is how a reconciliation report comes back
   * clean on the day it mattered.
   */
  UNKNOWN: 'UNKNOWN',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export const ItemSubject = {
  BALANCE: 'BALANCE',
  ORDER: 'ORDER',
  POSITION: 'POSITION',
  EXECUTION: 'EXECUTION',
} as const;
export type ItemSubject = (typeof ItemSubject)[keyof typeof ItemSubject];

export interface ReconciliationItem {
  readonly subject: ItemSubject;
  /** What both sides call this thing. A client order id, a position id, or the account. */
  readonly key: string;
  readonly status: ItemStatus;
  /** The field that disagreed, when one did. */
  readonly field: string | null;
  /** Decimal strings, kept as text: evidence, not operands. */
  readonly internal: string | null;
  readonly external: string | null;
  readonly difference: string | null;
  /**
   * The tolerance that was applied, when one was, so a reader can tell "these
   * agreed" from "these were close enough by a rule somebody set".
   */
  readonly tolerance: string | null;
  readonly message: string;
}

/**
 * How much difference is not a difference.
 *
 * Zero everywhere by default, and that is the right default: a fee that is a
 * cent out is a cent that came from somewhere. A tolerance is a decision a firm
 * makes about a particular venue — one that rounds swap to five decimals, say —
 * and it is recorded on every item it is applied to rather than silently
 * swallowing the difference.
 *
 * Never a floating-point epsilon. These are decimals; "close enough" is a
 * business rule with a number attached, not an artefact of binary arithmetic.
 */
export interface Tolerances {
  readonly quantity?: string;
  readonly price?: string;
  readonly fee?: string;
  readonly balance?: string;
}

const NONE: Required<Tolerances> = { quantity: '0', price: '0', fee: '0', balance: '0' };

function withDefaults(tolerances: Tolerances | undefined): Required<Tolerances> {
  return { ...NONE, ...tolerances };
}

/** A number the comparison can use, or null if it is not one. */
function decimalOrNull(value: string | null | undefined): ReturnType<typeof toDecimal> | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    const decimal = toDecimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/**
 * Compare one numeric field.
 *
 * Returns `null` when the two agree within tolerance — the caller decides
 * whether "no disagreement on this field" means MATCHED, because an item with
 * several fields is only matched when none of them disagreed.
 */
function compareField(args: {
  readonly subject: ItemSubject;
  readonly key: string;
  readonly field: string;
  readonly status: ItemStatus;
  readonly internal: string | null;
  readonly external: string | null;
  readonly tolerance: string;
  readonly label: string;
}): ReconciliationItem | null {
  const internal = decimalOrNull(args.internal);
  const external = decimalOrNull(args.external);

  if (internal === null || external === null) {
    /**
     * One side has no number. Not a mismatch — a mismatch is a claim that two
     * numbers differ, and there are not two numbers here.
     */
    return {
      subject: args.subject,
      key: args.key,
      status: ItemStatus.UNKNOWN,
      field: args.field,
      internal: args.internal ?? null,
      external: args.external ?? null,
      difference: null,
      tolerance: null,
      message: `${args.label} could not be compared: ${
        internal === null ? 'this platform' : 'the venue'
      } gave no usable number`,
    };
  }

  const difference = internal.minus(external);
  const tolerance = toDecimal(args.tolerance);
  if (difference.abs().lessThanOrEqualTo(tolerance)) return null;

  return {
    subject: args.subject,
    key: args.key,
    status: args.status,
    field: args.field,
    internal: internal.toString(),
    external: external.toString(),
    difference: difference.toString(),
    tolerance: tolerance.isZero() ? null : tolerance.toString(),
    message: `${args.label}: this platform has ${internal.toString()}, the venue has ${external.toString()}`,
  };
}

function matched(subject: ItemSubject, key: string, message: string): ReconciliationItem {
  return {
    subject,
    key,
    status: ItemStatus.MATCHED,
    field: null,
    internal: null,
    external: null,
    difference: null,
    tolerance: null,
    message,
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface InternalBalance {
  readonly accountNumber: string;
  readonly currency: string;
  readonly balance: string;
  readonly equity: string;
}

export interface ExternalBalance {
  readonly currency: string;
  readonly balance: string;
  readonly equity: string;
}

/**
 * The account's money, as each side sees it.
 *
 * Currency is compared first and stops everything: two numbers in different
 * currencies do not differ by their subtraction, and reporting that they do
 * would be a number worse than no number.
 */
export function compareBalance(
  internal: InternalBalance,
  external: ExternalBalance,
  tolerances?: Tolerances,
): readonly ReconciliationItem[] {
  const key = internal.accountNumber;
  const t = withDefaults(tolerances);

  if (internal.currency !== external.currency) {
    return [
      {
        subject: ItemSubject.BALANCE,
        key,
        status: ItemStatus.UNKNOWN,
        field: 'currency',
        internal: internal.currency,
        external: external.currency,
        difference: null,
        tolerance: null,
        message: `The account is ${internal.currency} here and ${external.currency} at the venue; the balances are not comparable`,
      },
    ];
  }

  const items = [
    compareField({
      subject: ItemSubject.BALANCE,
      key,
      field: 'balance',
      status: ItemStatus.BALANCE_MISMATCH,
      internal: internal.balance,
      external: external.balance,
      tolerance: t.balance,
      label: 'Balance',
    }),
    compareField({
      subject: ItemSubject.BALANCE,
      key,
      field: 'equity',
      status: ItemStatus.BALANCE_MISMATCH,
      internal: internal.equity,
      external: external.equity,
      tolerance: t.balance,
      label: 'Equity',
    }),
  ].filter((item): item is ReconciliationItem => item !== null);

  return items.length === 0
    ? [matched(ItemSubject.BALANCE, key, 'Balance and equity agree with the venue')]
    : items;
}

// ---------------------------------------------------------------------------
// Orders, positions, executions
// ---------------------------------------------------------------------------

export interface InternalOrder {
  /** The id this platform sent the venue. The join between the two sides. */
  readonly clientOrderId: string;
  readonly volume: string;
  readonly filledVolume: string;
  readonly price: string | null;
  readonly status: string;
}

export interface ExternalOrder {
  readonly clientOrderId: string | null;
  readonly externalOrderId: string;
  readonly volume: string;
  readonly filledVolume: string;
  readonly price: string | null;
  readonly status: string;
}

export interface InternalPosition {
  readonly externalPositionId: string;
  readonly volume: string;
  readonly entryPrice: string;
}

export interface ExternalPosition {
  readonly externalPositionId: string;
  readonly volume: string;
  readonly entryPrice: string;
}

export interface InternalExecution {
  readonly externalExecutionId: string;
  readonly volume: string;
  readonly price: string;
  readonly commission: string | null;
}

export interface ExternalExecution {
  readonly externalExecutionId: string;
  readonly volume: string;
  readonly price: string;
  readonly commission: string | null;
}

/**
 * Pair two sides up by key, and say what only one side had.
 *
 * The unmatched halves are the findings that matter most: an order the venue
 * has and we do not is a trade nobody here booked, and an order we have and the
 * venue does not is a position we believe in and nobody is holding.
 */
function pair<I, E>(
  internal: readonly I[],
  external: readonly E[],
  internalKey: (row: I) => string,
  externalKey: (row: E) => string | null,
): {
  readonly both: ReadonlyArray<readonly [string, I, E]>;
  readonly onlyInternal: ReadonlyArray<readonly [string, I]>;
  readonly onlyExternal: ReadonlyArray<readonly [string, E]>;
} {
  const externalByKey = new Map<string, E>();
  const externalUnkeyed: E[] = [];
  for (const row of external) {
    const key = externalKey(row);
    if (key === null || key === '') externalUnkeyed.push(row);
    else externalByKey.set(key, row);
  }

  const both: Array<readonly [string, I, E]> = [];
  const onlyInternal: Array<readonly [string, I]> = [];
  const seen = new Set<string>();

  for (const row of internal) {
    const key = internalKey(row);
    const match = externalByKey.get(key);
    if (match === undefined) {
      onlyInternal.push([key, row]);
      continue;
    }
    both.push([key, row, match]);
    seen.add(key);
  }

  const onlyExternal: Array<readonly [string, E]> = [];
  for (const [key, row] of externalByKey) {
    if (!seen.has(key)) onlyExternal.push([key, row]);
  }
  /**
   * A venue row with no key of ours cannot be matched to anything, and is
   * reported as unmatched rather than dropped. Dropping it is how a trade
   * placed outside this platform stays invisible.
   */
  for (const row of externalUnkeyed) onlyExternal.push(['', row]);

  return { both, onlyInternal, onlyExternal };
}

export function compareOrders(
  internal: readonly InternalOrder[],
  external: readonly ExternalOrder[],
  tolerances?: Tolerances,
): readonly ReconciliationItem[] {
  const t = withDefaults(tolerances);
  const { both, onlyInternal, onlyExternal } = pair(
    internal,
    external,
    (row) => row.clientOrderId,
    (row) => row.clientOrderId,
  );

  const items: ReconciliationItem[] = [];

  for (const [key] of onlyInternal) {
    items.push({
      subject: ItemSubject.ORDER,
      key,
      status: ItemStatus.MISSING_EXTERNAL,
      field: null,
      internal: key,
      external: null,
      difference: null,
      tolerance: null,
      message: 'This platform has an order the venue does not report',
    });
  }

  for (const [key, row] of onlyExternal) {
    items.push({
      subject: ItemSubject.ORDER,
      key: key === '' ? row.externalOrderId : key,
      status: ItemStatus.MISSING_INTERNAL,
      field: null,
      internal: null,
      external: row.externalOrderId,
      difference: null,
      tolerance: null,
      message:
        key === ''
          ? 'The venue reports an order this platform never sent — it carries no client order id'
          : 'The venue reports an order this platform has no record of',
    });
  }

  for (const [key, ours, theirs] of both) {
    /**
     * Volume first, then fill, then price. One item per field that disagrees,
     * because "the volume and the price are both wrong" and "the volume is
     * wrong" are different investigations.
     */
    const fields = [
      compareField({
        subject: ItemSubject.ORDER,
        key,
        field: 'volume',
        status: ItemStatus.QUANTITY_MISMATCH,
        internal: ours.volume,
        external: theirs.volume,
        tolerance: t.quantity,
        label: 'Order volume',
      }),
      compareField({
        subject: ItemSubject.ORDER,
        key,
        field: 'filledVolume',
        status: ItemStatus.QUANTITY_MISMATCH,
        internal: ours.filledVolume,
        external: theirs.filledVolume,
        tolerance: t.quantity,
        label: 'Filled volume',
      }),
    ].filter((item): item is ReconciliationItem => item !== null);

    /**
     * Price is compared only when both sides have one. A market order has no
     * price on either side, and an UNKNOWN for every market order would bury
     * the report in noise about the one thing that is working correctly.
     */
    if (ours.price !== null && theirs.price !== null) {
      const price = compareField({
        subject: ItemSubject.ORDER,
        key,
        field: 'price',
        status: ItemStatus.PRICE_MISMATCH,
        internal: ours.price,
        external: theirs.price,
        tolerance: t.price,
        label: 'Order price',
      });
      if (price !== null) fields.push(price);
    }

    items.push(
      ...(fields.length === 0
        ? [matched(ItemSubject.ORDER, key, 'The order agrees with the venue')]
        : fields),
    );
  }

  return items;
}

export function comparePositions(
  internal: readonly InternalPosition[],
  external: readonly ExternalPosition[],
  tolerances?: Tolerances,
): readonly ReconciliationItem[] {
  const t = withDefaults(tolerances);
  const { both, onlyInternal, onlyExternal } = pair(
    internal,
    external,
    (row) => row.externalPositionId,
    (row) => row.externalPositionId,
  );

  const items: ReconciliationItem[] = [];

  for (const [key] of onlyInternal) {
    items.push({
      subject: ItemSubject.POSITION,
      key,
      status: ItemStatus.MISSING_EXTERNAL,
      field: null,
      internal: key,
      external: null,
      difference: null,
      tolerance: null,
      message: 'This platform holds a position the venue does not report',
    });
  }
  for (const [key, row] of onlyExternal) {
    items.push({
      subject: ItemSubject.POSITION,
      key: key === '' ? row.externalPositionId : key,
      status: ItemStatus.MISSING_INTERNAL,
      field: null,
      internal: null,
      external: row.externalPositionId,
      difference: null,
      tolerance: null,
      message: 'The venue holds a position this platform has no record of',
    });
  }

  for (const [key, ours, theirs] of both) {
    const fields = [
      compareField({
        subject: ItemSubject.POSITION,
        key,
        field: 'volume',
        status: ItemStatus.QUANTITY_MISMATCH,
        internal: ours.volume,
        external: theirs.volume,
        tolerance: t.quantity,
        label: 'Position volume',
      }),
      compareField({
        subject: ItemSubject.POSITION,
        key,
        field: 'entryPrice',
        status: ItemStatus.PRICE_MISMATCH,
        internal: ours.entryPrice,
        external: theirs.entryPrice,
        tolerance: t.price,
        label: 'Entry price',
      }),
    ].filter((item): item is ReconciliationItem => item !== null);

    items.push(
      ...(fields.length === 0
        ? [matched(ItemSubject.POSITION, key, 'The position agrees with the venue')]
        : fields),
    );
  }

  return items;
}

export function compareExecutions(
  internal: readonly InternalExecution[],
  external: readonly ExternalExecution[],
  tolerances?: Tolerances,
): readonly ReconciliationItem[] {
  const t = withDefaults(tolerances);
  const { both, onlyInternal, onlyExternal } = pair(
    internal,
    external,
    (row) => row.externalExecutionId,
    (row) => row.externalExecutionId,
  );

  const items: ReconciliationItem[] = [];

  for (const [key] of onlyInternal) {
    items.push({
      subject: ItemSubject.EXECUTION,
      key,
      status: ItemStatus.MISSING_EXTERNAL,
      field: null,
      internal: key,
      external: null,
      difference: null,
      tolerance: null,
      message: 'This platform booked a fill the venue does not report',
    });
  }
  for (const [key, row] of onlyExternal) {
    items.push({
      subject: ItemSubject.EXECUTION,
      key: key === '' ? row.externalExecutionId : key,
      status: ItemStatus.MISSING_INTERNAL,
      field: null,
      internal: null,
      external: row.externalExecutionId,
      difference: null,
      tolerance: null,
      message: 'The venue reports a fill this platform never booked',
    });
  }

  for (const [key, ours, theirs] of both) {
    const fields = [
      compareField({
        subject: ItemSubject.EXECUTION,
        key,
        field: 'volume',
        status: ItemStatus.QUANTITY_MISMATCH,
        internal: ours.volume,
        external: theirs.volume,
        tolerance: t.quantity,
        label: 'Fill volume',
      }),
      compareField({
        subject: ItemSubject.EXECUTION,
        key,
        field: 'price',
        status: ItemStatus.PRICE_MISMATCH,
        internal: ours.price,
        external: theirs.price,
        tolerance: t.price,
        label: 'Fill price',
      }),
    ].filter((item): item is ReconciliationItem => item !== null);

    /**
     * Commission is compared only when both sides quote one. A venue that does
     * not report commission per fill is not a venue that charges zero, and
     * recording a FEE_MISMATCH of the full amount against it would be a finding
     * about our own assumption rather than about the money.
     */
    if (ours.commission !== null && theirs.commission !== null) {
      const fee = compareField({
        subject: ItemSubject.EXECUTION,
        key,
        field: 'commission',
        status: ItemStatus.FEE_MISMATCH,
        internal: ours.commission,
        external: theirs.commission,
        tolerance: t.fee,
        label: 'Commission',
      });
      if (fee !== null) fields.push(fee);
    }

    items.push(
      ...(fields.length === 0
        ? [matched(ItemSubject.EXECUTION, key, 'The fill agrees with the venue')]
        : fields),
    );
  }

  return items;
}

/**
 * Commission charged over a window, as a total.
 *
 * Per fill would be better and is not possible: this platform books commission
 * against the *position*, and a venue reports it against the fill. There is no
 * honest way to split ours back out into theirs, and a FEE_MISMATCH per fill
 * derived from a guess about the split would be a finding about the guess.
 *
 * So the comparison is the one both sides can actually make: everything
 * charged on this account over this window, on each side. It is what a finance
 * person checks, and it catches the thing that matters — a venue charging more
 * than the platform has booked — without pretending to a precision neither
 * side has.
 */
export function compareFeeTotals(
  accountNumber: string,
  internalTotal: string,
  externalTotal: string | null,
  tolerances?: Tolerances,
): readonly ReconciliationItem[] {
  const t = withDefaults(tolerances);
  /**
   * A venue that reports no commission at all is not a venue that charges
   * nothing. Comparing our total against an assumed zero would raise a
   * mismatch for the whole amount, every run, against every such venue.
   */
  if (externalTotal === null) {
    const ours = decimalOrNull(internalTotal);
    /**
     * Nothing was charged here and the venue said nothing. That is an absence,
     * not a discrepancy and not an agreement — so it produces no item at all.
     *
     * Reporting UNKNOWN here would put one on every quiet account on every run,
     * and a report where the normal state is a page of UNKNOWNs is a report
     * nobody reads closely enough to spot the real one.
     */
    if (ours !== null && ours.isZero()) return [];
    return [
      {
        subject: ItemSubject.EXECUTION,
        key: accountNumber,
        status: ItemStatus.UNKNOWN,
        field: 'commissionTotal',
        internal: internalTotal,
        external: null,
        difference: null,
        tolerance: null,
        message: 'The venue does not report commission, so the total cannot be checked',
      },
    ];
  }

  const item = compareField({
    subject: ItemSubject.EXECUTION,
    key: accountNumber,
    field: 'commissionTotal',
    status: ItemStatus.FEE_MISMATCH,
    internal: internalTotal,
    external: externalTotal,
    tolerance: t.fee,
    label: 'Commission over the window',
  });
  return item === null
    ? [matched(ItemSubject.EXECUTION, accountNumber, 'Commission agrees with the venue')]
    : [item];
}

// ---------------------------------------------------------------------------

/** Counts for a run summary, so a console can say what a pass found at a glance. */
export function tally(items: readonly ReconciliationItem[]): Readonly<Record<ItemStatus, number>> {
  const counts = Object.fromEntries(
    Object.values(ItemStatus).map((status) => [status, 0]),
  ) as Record<ItemStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/**
 * Whether a run found anything a person needs to see.
 *
 * `UNKNOWN` counts. An item nobody could compare is not a clean item, and a
 * report that treats it as one is a report that goes green on the day the
 * venue starts returning empty fields.
 */
export function needsAttention(items: readonly ReconciliationItem[]): boolean {
  return items.some((item) => item.status !== ItemStatus.MATCHED);
}
