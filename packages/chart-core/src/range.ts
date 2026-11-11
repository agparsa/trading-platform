import type { ChartBar } from './datafeed';

/**
 * The highest high and lowest low of the bars on the chart, as the server
 * wrote them — the "H … L …" line over a phone's chart.
 *
 * Compared as numbers, returned as the bars' own strings, so the figure shown
 * is one a bar carries rather than a float's idea of it. Null with no bars, and
 * a bar with an unreadable price is skipped rather than allowed to win.
 */
export function rangeOf(bars: readonly ChartBar[]): { high: string; low: string } | null {
  let high: string | null = null;
  let low: string | null = null;
  for (const bar of bars) {
    const h = Number(bar.high);
    const l = Number(bar.low);
    if (Number.isFinite(h) && (high === null || h > Number(high))) high = bar.high;
    if (Number.isFinite(l) && (low === null || l < Number(low))) low = bar.low;
  }
  return high === null || low === null ? null : { high, low };
}
