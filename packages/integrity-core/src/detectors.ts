import { toDecimal, type Decimal } from '@tp/financial-core';
import {
  DEFAULT_THRESHOLDS,
  SignalCode,
  SignalSeverity,
  type ActivityWindow,
  type IntegrityThresholds,
  type OrderObservation,
  type Signal,
} from './types';

/**
 * The detectors.
 *
 * Each one answers a single question of the form "did this account do X more
 * than N times in the last M?" and returns a signal or nothing. They share three
 * rules.
 *
 * **They observe, they do not conclude.** Every message states what was counted.
 * A reviewer reading "14 orders in 10s" can decide whether that is a scalper, a
 * misconfigured bot or an attack; a reviewer reading "order flooding detected"
 * has been told the answer by a threshold.
 *
 * **They carry their evidence.** A signal a person cannot check is a signal a
 * person has to trust, and nobody should have to trust an automated accusation.
 *
 * **They are severity-capped at HIGH.** Nothing here returns `CRITICAL`. A
 * pattern in trading activity is not, on its own, ever the most serious thing
 * this platform can say — that is reserved for a balance that is not backed by
 * the ledger, where the system knows something is actually wrong rather than
 * merely unusual.
 */

export function detectAll(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal[] {
  return [
    detectOrderBurst(window, thresholds),
    detectRepeatedRejections(window, thresholds),
    detectDuplicateOrders(window, thresholds),
    detectRapidOpenClose(window, thresholds),
    detectVolumeSpike(window, thresholds),
    detectConcentration(window, thresholds),
  ].filter((signal): signal is Signal => signal !== null);
}

function within(order: { createdAtMs: number }, nowMs: number, windowMs: number): boolean {
  return nowMs - order.createdAtMs <= windowMs;
}

/**
 * Orders arriving faster than a person plausibly places them.
 *
 * The count is taken over the *densest* window rather than the last one, because
 * a burst that straddles the boundary of a fixed window is a burst that a fixed
 * window cannot see. Fourteen orders in two seconds should be visible whether
 * they landed at the start of the minute or across it.
 */
export function detectOrderBurst(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { windowMs, count } = thresholds.orderBurst;
  const times = window.orders
    .filter((order) => within(order, window.nowMs, windowMs * 6))
    .map((order) => order.createdAtMs)
    .sort((a, b) => a - b);

  const densest = densestRun(times, windowMs);
  if (densest.count < count) return null;

  return {
    code: SignalCode.ORDER_BURST,
    severity: densest.count >= count * 3 ? SignalSeverity.HIGH : SignalSeverity.MEDIUM,
    message: `${densest.count} orders in ${Math.round(densest.spanMs / 1000)}s`,
    evidence: {
      orders: densest.count,
      spanMs: densest.spanMs,
      threshold: count,
      windowMs,
    },
  };
}

/** The most events any `windowMs`-wide slice contains, and how wide that slice was. */
function densestRun(
  sorted: readonly number[],
  windowMs: number,
): { count: number; spanMs: number } {
  let best = { count: 0, spanMs: 0 };
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) > windowMs) start += 1;
    const count = end - start + 1;
    if (count > best.count) best = { count, spanMs: (sorted[end] ?? 0) - (sorted[start] ?? 0) };
  }
  return best;
}

/**
 * Repeated rejections.
 *
 * Worth noticing and easy to over-read. The commonest cause by far is a broken
 * client retrying something the engine will never accept — which is a support
 * problem, not a fraud one. The message says how many and leaves it there.
 */
export function detectRepeatedRejections(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { windowMs, count } = thresholds.repeatedRejections;
  const rejected = window.orders.filter(
    (order) => order.status === 'REJECTED' && within(order, window.nowMs, windowMs),
  );
  if (rejected.length < count) return null;

  return {
    code: SignalCode.REPEATED_REJECTIONS,
    severity: SignalSeverity.LOW,
    message: `${rejected.length} orders rejected in ${Math.round(windowMs / 1000)}s`,
    evidence: {
      rejected: rejected.length,
      threshold: count,
      windowMs,
      firstOrderId: rejected[0]?.id ?? '',
    },
  };
}

/**
 * The same order sent repeatedly in a very short window.
 *
 * "The same" means the same instrument, side, volume and price. Idempotency
 * already prevents a retried request from executing twice; this notices the
 * client that keeps *asking*, which idempotency handles silently and nobody
 * would otherwise see.
 */
export function detectDuplicateOrders(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { windowMs, count } = thresholds.duplicateOrders;
  const recent = window.orders.filter((order) => within(order, window.nowMs, windowMs * 12));

  const groups = new Map<string, OrderObservation[]>();
  for (const order of recent) {
    const key = `${order.symbol}|${order.side}|${order.volume}|${order.price ?? 'MKT'}`;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }

  for (const [key, orders] of groups) {
    const times = orders.map((order) => order.createdAtMs).sort((a, b) => a - b);
    const densest = densestRun(times, windowMs);
    if (densest.count < count) continue;
    return {
      code: SignalCode.DUPLICATE_ORDER_ATTEMPTS,
      severity: SignalSeverity.MEDIUM,
      message: `${densest.count} identical orders in ${Math.round(densest.spanMs / 1000)}s`,
      evidence: {
        order: key,
        attempts: densest.count,
        spanMs: densest.spanMs,
        threshold: count,
      },
    };
  }
  return null;
}

/**
 * Positions opened and closed within seconds, repeatedly.
 *
 * Deliberately **LOW**. This is what scalping looks like from the outside, and
 * scalping is a strategy rather than an offence. It is here because the same
 * shape also appears when somebody is testing an execution boundary, and the
 * difference is not something a threshold can tell.
 */
export function detectRapidOpenClose(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { windowMs, holdMs, count } = thresholds.rapidOpenClose;
  const brief = window.closedPositions.filter(
    (position) =>
      window.nowMs - position.closedAtMs <= windowMs &&
      position.closedAtMs - position.openedAtMs <= holdMs,
  );
  if (brief.length < count) return null;

  const shortest = brief.reduce(
    (least, position) => Math.min(least, position.closedAtMs - position.openedAtMs),
    Number.POSITIVE_INFINITY,
  );
  return {
    code: SignalCode.RAPID_OPEN_CLOSE,
    severity: SignalSeverity.LOW,
    message: `${brief.length} positions held under ${holdMs / 1000}s`,
    evidence: {
      positions: brief.length,
      shortestHoldMs: shortest,
      threshold: count,
      windowMs,
    },
  };
}

/**
 * An order far larger than this account's own recent norm.
 *
 * Compared against the account's **median**, not a platform-wide figure: a size
 * that is unremarkable on one desk is extraordinary on another, and a fixed
 * number would flag every large account continuously while never noticing a
 * small one behaving strangely.
 *
 * The median rather than the mean, because a single outlier drags a mean towards
 * itself and helps to hide the next one.
 */
export function detectVolumeSpike(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { multiple, minimumSample } = thresholds.volumeSpike;
  const volumes = window.orders.map((order) => toDecimal(order.volume));
  // Too few orders to have a norm. Guessing one would flag an account's second
  // ever trade for being bigger than its first.
  if (volumes.length < minimumSample) return null;

  const middle = median(volumes);
  if (middle.lte(0)) return null;

  const largest = volumes.reduce((max, volume) => (volume.gt(max) ? volume : max), toDecimal(0));
  const ratio = largest.div(middle);
  if (ratio.lt(multiple)) return null;

  return {
    code: SignalCode.VOLUME_SPIKE,
    severity: ratio.gte(multiple * 5) ? SignalSeverity.HIGH : SignalSeverity.MEDIUM,
    message: `an order ${ratio.toDecimalPlaces(1).toString()}× this account's median size`,
    evidence: {
      largest: largest.toString(),
      median: middle.toString(),
      ratio: ratio.toDecimalPlaces(2).toString(),
      threshold: multiple,
      sample: volumes.length,
    },
  };
}

function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? toDecimal(0);
  return (sorted[middle - 1] ?? toDecimal(0)).plus(sorted[middle] ?? toDecimal(0)).div(2);
}

/**
 * Most of an account's exposure in one instrument.
 *
 * A risk observation rather than a suspicion, and the minimum-notional floor is
 * what keeps it from being noise: an account holding one small position is 100%
 * concentrated by arithmetic and by nothing else.
 */
export function detectConcentration(
  window: ActivityWindow,
  thresholds: IntegrityThresholds = DEFAULT_THRESHOLDS,
): Signal | null {
  const { share, minimumNotional } = thresholds.concentration;
  if (window.exposure.length === 0) return null;

  let total = toDecimal(0);
  let largest = { symbol: '', notional: toDecimal(0) };
  for (const entry of window.exposure) {
    const notional = toDecimal(entry.grossNotional);
    total = total.plus(notional);
    if (notional.gt(largest.notional)) largest = { symbol: entry.symbol, notional };
  }

  if (total.lt(toDecimal(minimumNotional))) return null;
  if (total.lte(0)) return null;
  // One instrument is trivially 100% of itself. Concentration only means
  // something once there was an alternative.
  if (window.exposure.length < 2) return null;

  const fraction = largest.notional.div(total);
  if (fraction.lt(share)) return null;

  return {
    code: SignalCode.CONCENTRATION,
    severity: SignalSeverity.LOW,
    message: `${fraction.mul(100).toDecimalPlaces(1).toString()}% of exposure in ${largest.symbol}`,
    evidence: {
      symbol: largest.symbol,
      notional: largest.notional.toString(),
      totalNotional: total.toString(),
      share: fraction.toDecimalPlaces(4).toString(),
      threshold: share,
    },
  };
}
