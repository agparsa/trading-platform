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
