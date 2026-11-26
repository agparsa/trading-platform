import { toDecimal } from '@tp/financial-core';

/**
 * A day of an instrument in one glance: the closes to draw, and the move since
 * the first of them as a percent. For the eye — a list's sparkline and its
 * "+0.42%" — never for anything that trades. The percent is worked in decimals
 * and rounded to two places; the points are scaled to the box they are drawn in.
 */
export function changePercent(first: string | null, last: string | null): string | null {
  if (first === null || last === null) return null;
  try {
    const from = toDecimal(first);
    if (!from.greaterThan(0)) return null;
    const pct = toDecimal(last).minus(from).div(from).mul(100);
    const fixed = pct.toFixed(2);
    return pct.greaterThan(0) ? `+${fixed}%` : `${fixed === '-0.00' ? '0.00' : fixed}%`;
  } catch {
    return null;
  }
}

/** The polyline for `values` inside a `width` × `height` box, a little inset. */
export function sparkPath(values: readonly number[], width: number, height: number): string {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return '';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const inset = 2;
  const step = (width - inset * 2) / (points.length - 1);
  return points
    .map((value, index) => {
      const x = inset + index * step;
      const y = inset + (height - inset * 2) * (1 - (value - min) / span);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
