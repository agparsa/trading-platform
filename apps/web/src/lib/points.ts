/**
 * Distances expressed in points.
 *
 * A "point" is one unit of the instrument's last displayed decimal — 0.00001 on
 * a five-decimal FX pair, 0.01 on gold. It is how traders talk about how far an
 * order is from firing, and it is the only unit in which "twelve away" means the
 * same thing on EURUSD and XAUUSD.
 *
 * `Number` is deliberate here and safe for the same reason it is safe in
 * `format.ts`: this is a figure shown on screen. It is never sent anywhere,
 * never stored, and nothing is decided from it — the server decides when an
 * order fires, using decimal arithmetic, against its own quote.
 */
import { entrySideOf } from '@tp/financial-core';

/**
 * How far `orderPrice` is from `reference`, in whole points, or `null` when
 * there is nothing to compare against.
 *
 * Unsigned: a resting order's distance is a distance, and which side of the
 * market it sits on is already shown by its type and side.
 */
export function distanceInPoints(
  orderPrice: string,
  reference: string | null | undefined,
  precision: number,
): number | null {
  if (reference === null || reference === undefined) return null;
  const target = Number(orderPrice);
  const market = Number(reference);
  if (!Number.isFinite(target) || !Number.isFinite(market)) return null;
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) return null;

  const points = Math.abs(target - market) * 10 ** precision;
  if (!Number.isFinite(points)) return null;
  return Math.round(points);
}

/**
 * The quote side a resting order of `side` would actually fire against.
 *
 * A BUY fills at the ask and a SELL at the bid. Measuring both against the mid
 * would understate the distance by half the spread — which is exactly the moment
 * it matters, because a wide spread is when a trader is deciding whether the
 * order is about to trigger.
 */
export function triggerSide(
  side: 'BUY' | 'SELL',
  quote: { bid: string; ask: string } | undefined,
): string | null {
  if (quote === undefined) return null;
  return quote[entrySideOf(side)];
}
