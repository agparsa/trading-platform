import { toDecimal } from '@tp/financial-core';
import { priceAtPoints } from '@tp/trading-core';

/**
 * A stop or a target typed as whole points from a reference price, turned
 * into the price the server takes — a level is an order, and an order has a
 * price. The calculator is `@tp/trading-core`'s, the one the web ticket and
 * the chart already read from; nothing here is consulted by the server, which
 * checks the resulting price as it checks every level.
 *
 * `null` while it cannot be said: empty, not a whole positive number, or no
 * reference price yet.
 */
export function priceFromPoints(
  points: string,
  from: string | null,
  priceDecimals: number,
  side: 'BUY' | 'SELL',
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
): string | null {
  const text = points.trim();
  if (from === null || !/^\d+$/.test(text) || Number(text) <= 0) return null;
  const price = priceAtPoints(from, Number(text), priceDecimals, side, kind);
  if (price === null) return null;
  const exact = toDecimal(price);
  if (!exact.isFinite() || !exact.greaterThan(0)) return null;
  return exact.toFixed(priceDecimals);
}

/**
 * The lots one step up or down the instrument's grid, never below its
 * minimum. Exact decimal arithmetic; a half-typed value starts from the
 * minimum. Without the grid yet, the value is left as it is.
 */
export function stepLots(
  current: string,
  grid: { step: string; min: string } | null,
  direction: 1 | -1,
): string {
  if (grid === null) return current;
  const step = toDecimal(grid.step);
  const min = toDecimal(grid.min);
  if (!step.greaterThan(0)) return current;
  const places = Math.max(step.decimalPlaces(), min.decimalPlaces());
  const base = /^\d+(\.\d+)?$/.test(current.trim()) ? toDecimal(current.trim()) : min;
  // Snapped to the grid first, so 0.105 steps to 0.11 and 0.10, not 0.115.
  const snapped = base.div(step).toDecimalPlaces(0).mul(step);
  const next = snapped.add(step.mul(direction));
  return (next.lessThan(min) ? min : next).toFixed(places);
}
