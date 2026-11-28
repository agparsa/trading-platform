import type { ChartBar } from '@tp/chart-core';

/** What the chart is following: one instrument at one timeframe. */
export interface CandleWatch {
  readonly symbol: string;
  readonly resolution: string;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * The bar a `candle.update` frame carries, if it belongs to the chart on
 * screen; otherwise null.
 *
 * The server sends the in-progress bar on every tick, plus the final state of a
 * bar that has just closed. Both are drawn: the first moves the last candle,
 * the second settles the one before it. A frame for another instrument or
 * timeframe (a subscription switched a moment ago), or one that is malformed,
 * is ignored rather than drawn on the wrong chart.
 */
export function liveBarFor(data: unknown, watch: CandleWatch | null): ChartBar | null {
  if (watch === null || typeof data !== 'object' || data === null) return null;
  const bar = data as Record<string, unknown>;
  if (bar['symbol'] !== watch.symbol || String(bar['resolution']) !== watch.resolution) return null;
  const time = bar['time'];
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  const prices = ['open', 'high', 'low', 'close'].map((key) => bar[key]);
  if (!prices.every((p) => typeof p === 'string' && DECIMAL.test(p))) return null;
  const [open = '', high = '', low = '', close = ''] = prices as string[];
  const volume = bar['volume'];
  return { time, open, high, low, close, volume: typeof volume === 'string' ? volume : '0' };
}
