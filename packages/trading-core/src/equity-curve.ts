import { Decimal } from '@tp/financial-core';
import { dayIn } from './performance';

/**
 * An account's balance and equity, one point per trading day, from the
 * platform's own snapshots — and the worst fall in equity along the way.
 *
 * Only recorded snapshots are used: a day on which nothing was recorded
 * (the snapshot pass skips an account with nothing open and nothing moved)
 * is absent, not filled in. The day's point is its *last* snapshot, in the
 * trading server's timezone, because that is what the account closed the day
 * at. The low of the day is kept beside it, so a drawdown that recovered
 * before the close is still seen.
 *
 * Drawdown is peak-to-trough in equity across the snapshots in time order:
 * the largest `peak − equity` seen, and the same as a percentage of the peak
 * it fell from. With no fall it is zero, not null — "no drawdown" is a fact.
 */
export interface EquitySample {
  readonly takenAt: Date;
  readonly balance: string;
  readonly equity: string;
}

export interface EquityCurvePoint {
  /** `YYYY-MM-DD` in the trading server's timezone. */
  readonly day: string;
  readonly balance: string;
  readonly equity: string;
  /** The lowest equity recorded that day. */
  readonly lowEquity: string;
}

export interface EquityCurve {
  readonly points: readonly EquityCurvePoint[];
  readonly peakEquity: string | null;
  readonly maxDrawdown: string;
  /** Two places; null when there is no positive peak to measure against. */
  readonly maxDrawdownPercent: string | null;
}

export function equityCurve(samples: readonly EquitySample[], timeZone: string): EquityCurve {
  const ordered = [...samples].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const days = new Map<string, { balance: Decimal; equity: Decimal; low: Decimal }>();
  let peak: Decimal | null = null;
  let worst = new Decimal(0);
  let worstPeak: Decimal | null = null;

  for (const sample of ordered) {
    const equity = new Decimal(sample.equity);
    const balance = new Decimal(sample.balance);
    const key = dayIn(sample.takenAt, timeZone);
    const seen = days.get(key);
    days.set(key, {
      balance,
      equity,
      low: seen === undefined || equity.lessThan(seen.low) ? equity : seen.low,
    });

    if (peak === null || equity.greaterThan(peak)) peak = equity;
    const fall = peak.minus(equity);
    if (fall.greaterThan(worst)) {
      worst = fall;
      worstPeak = peak;
    }
  }

  return {
    points: [...days.entries()].map(([day, row]) => ({
      day,
      balance: row.balance.toString(),
      equity: row.equity.toString(),
      lowEquity: row.low.toString(),
    })),
    peakEquity: peak === null ? null : peak.toString(),
    maxDrawdown: worst.toString(),
    maxDrawdownPercent:
      worstPeak === null
        ? peak !== null && peak.greaterThan(0)
          ? '0.00'
          : null
        : worstPeak.greaterThan(0)
          ? worst.dividedBy(worstPeak).times(100).toFixed(2, Decimal.ROUND_HALF_UP)
          : null,
  };
}
