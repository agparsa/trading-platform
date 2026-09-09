/**
 * What the integrity engine observes, and what it is allowed to say about it.
 *
 * The vocabulary matters here more than usual. This engine produces **signals**,
 * never verdicts: a signal is "this account did something worth a person
 * looking at", and nothing in this package is permitted to phrase it as "this
 * account is cheating". A pattern is evidence of a pattern. It is not evidence
 * of intent, and a system that conflates the two accuses its customers on the
 * strength of arithmetic.
 *
 * What this engine may see is also deliberately narrow — see `docs/anti-fraud.md`.
 * It reads orders, positions and exposure: records this platform already keeps
 * because trading created them. It collects nothing about a person that trading
 * did not already require.
 */

export const SignalSeverity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type SignalSeverity = (typeof SignalSeverity)[keyof typeof SignalSeverity];

export const SignalCode = {
  /** Orders arriving faster than a person plausibly places them. */
  ORDER_BURST: 'ORDER_BURST',
  /** Repeated rejections, which can mean a broken client or a probe. */
  REPEATED_REJECTIONS: 'REPEATED_REJECTIONS',
  /** The same order sent again and again in a very short window. */
  DUPLICATE_ORDER_ATTEMPTS: 'DUPLICATE_ORDER_ATTEMPTS',
  /** Positions opened and closed within seconds, repeatedly. */
  RAPID_OPEN_CLOSE: 'RAPID_OPEN_CLOSE',
  /** An order far larger than this account's own recent norm. */
  VOLUME_SPIKE: 'VOLUME_SPIKE',
  /** Most of the account's exposure in a single instrument. */
  CONCENTRATION: 'CONCENTRATION',
  /**
   * One resting order amended or cancelled over and over (§46).
   *
   * Different from `ORDER_BURST`, which counts *new* orders. This counts churn
   * on orders that already exist, and the two have different innocent
   * explanations: a burst is usually an automated strategy, while heavy
   * cancel/replace on one order is usually somebody chasing a price. Reporting
   * them as one code would make the common case bury the uncommon one.
   */
  RAPID_CANCEL_REPLACE: 'RAPID_CANCEL_REPLACE',
} as const;
export type SignalCode = (typeof SignalCode)[keyof typeof SignalCode];

/**
 * The review states a signal moves through.
 *
 * `FALSE_POSITIVE` is a first-class outcome rather than a variant of resolved.
 * A detector that is never wrong has not been looked at closely enough, and an
 * engine with no way to say "we looked, and this was nothing" trains its
 * operators to close things quietly instead.
 */
export const SignalStatus = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  INVESTIGATING: 'INVESTIGATING',
  RESOLVED: 'RESOLVED',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
} as const;
export type SignalStatus = (typeof SignalStatus)[keyof typeof SignalStatus];

export interface Signal {
  readonly code: SignalCode;
  readonly severity: SignalSeverity;
  /**
   * A description of what was observed, in the language of observation.
   *
   * "14 orders in 10 seconds", not "order flooding". The reader decides what it
   * means; this engine's job is to have noticed.
   */
  readonly message: string;
  /** What the observation was made from, so a reviewer can check it. */
  readonly evidence: Readonly<Record<string, string | number>>;
}

export interface OrderObservation {
  id: string;
  createdAtMs: number;
  status: string;
  symbol: string;
  side: string;
  /** Decimal string. */
  volume: string;
  /** Decimal string, or null for a market order. */
  price: string | null;
}

export interface ClosedPositionObservation {
  id: string;
  symbol: string;
  openedAtMs: number;
  closedAtMs: number;
}

/**
 * What happened to one resting order, as amendments and cancellations.
 *
 * Read from `OrderEvent`, which the platform already writes because the audit
 * trail must show the same shape for every order. Nothing new is collected to
 * make this detector possible — see `docs/anti-fraud.md`.
 */
export interface OrderChurnObservation {
  orderId: string;
  /** `MODIFIED` or `CANCELLED`, with when it happened. */
  kind: 'MODIFIED' | 'CANCELLED';
  atMs: number;
}

export interface SymbolExposureObservation {
  symbol: string;
  /** Decimal string, in account currency. */
  grossNotional: string;
}

/** One account's recent activity, as the engine is allowed to see it. */
export interface ActivityWindow {
  accountId: string;
  /** The instant the window was taken, so "recent" has a fixed meaning. */
  nowMs: number;
  orders: readonly OrderObservation[];
  closedPositions: readonly ClosedPositionObservation[];
  exposure: readonly SymbolExposureObservation[];
  /**
   * Amendments and cancellations on resting orders. Optional so an older caller
   * keeps working and simply produces no churn signal — a detector that cannot
   * see is better than one that guesses.
   */
  orderChurn?: readonly OrderChurnObservation[];
}

/**
 * Every number a detector uses, in one place.
 *
 * None of them is a constant in code. A threshold that cannot be changed without
 * a deployment is a threshold that gets worked around, and the right value for
 * "too many orders" depends on the desk, the instrument and the hour.
 */
export interface IntegrityThresholds {
  orderBurst: { windowMs: number; count: number };
  repeatedRejections: { windowMs: number; count: number };
  duplicateOrders: { windowMs: number; count: number };
  rapidOpenClose: { windowMs: number; holdMs: number; count: number };
  /** An order this many times the account's own median counts as a spike. */
  volumeSpike: { multiple: number; minimumSample: number };
  /** A share of gross exposure in one instrument, as a fraction of 1. */
  concentration: { share: number; minimumNotional: string };
  /** Amendments plus cancellations on a *single* order within the window. */
  rapidCancelReplace: { windowMs: number; count: number };
}

export const DEFAULT_THRESHOLDS: IntegrityThresholds = {
  orderBurst: { windowMs: 10_000, count: 12 },
  repeatedRejections: { windowMs: 60_000, count: 5 },
  duplicateOrders: { windowMs: 5_000, count: 3 },
  rapidOpenClose: { windowMs: 300_000, holdMs: 3_000, count: 5 },
  volumeSpike: { multiple: 10, minimumSample: 8 },
  concentration: { share: 0.9, minimumNotional: '50000' },
  /**
   * Eight amendments to one order in a minute. A trader chasing a price makes
   * two or three; eight is a machine, and a machine amending a resting order
   * eight times a minute is either a badly written strategy or somebody probing
   * how the book responds. Both are worth a person looking, and neither is an
   * accusation.
   */
  rapidCancelReplace: { windowMs: 60_000, count: 8 },
};
