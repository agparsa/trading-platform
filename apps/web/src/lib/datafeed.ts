import type { ApiClient } from '@tp/api-client';

/**
 * The datafeed boundary.
 *
 * Everything a chart needs from this platform passes through here: bar history
 * over REST, live bars over the `candles` WebSocket channel. Charting libraries
 * plug in on the far side.
 *
 * The boundary exists because the charting library is not settled. TradingView
 * Advanced Charts is licensed and distributed privately; `lightweight-charts`
 * renders the terminal today. Keeping the seam here means swapping renderers is
 * a change in `apps/web` alone — no engine, API or WebSocket change — which is
 * exactly what docs/charting.md promised in Phase 0.
 */

export type Resolution = '1' | '5' | '15' | '60' | '240' | '1D';

export const RESOLUTIONS: readonly Resolution[] = ['1', '5', '15', '60', '240', '1D'];

/** Minutes per bar. Must match CANDLE_RESOLUTIONS on the server. */
export const RESOLUTION_MINUTES: Readonly<Record<string, number>> = {
  '1': 1,
  '5': 5,
  '15': 15,
  '60': 60,
  '240': 240,
  '1D': 1440,
};

export const RESOLUTION_LABEL: Readonly<Record<string, string>> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1H',
  '240': '4H',
  '1D': '1D',
};

export function isResolution(value: string): value is Resolution {
  return RESOLUTIONS.includes(value as Resolution);
}

/** Milliseconds one bar spans. Unknown resolutions fall back to one minute. */
export function resolutionMs(resolution: string): number {
  return (RESOLUTION_MINUTES[resolution] ?? 1) * 60_000;
}

/**
 * The window covering `bars` bars ending at the current bar boundary.
 *
 * Snapped to the boundary rather than taken from the wall clock: an unsnapped
 * `to` changes on every render, which would make a query key change on every
 * render and refetch the whole series continuously.
 */
export function barWindow(
  resolution: string,
  bars: number,
  nowMs: number,
): { fromMs: number; toMs: number } {
  const span = resolutionMs(resolution);
  const toMs = Math.ceil(nowMs / span) * span;
  return { fromMs: toMs - bars * span, toMs };
}

export interface ChartBar {
  /** Bar open time, UTC milliseconds, bucketed to the resolution boundary. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface ChartDatafeed {
  history(
    symbol: string,
    resolution: string,
    fromMs: number,
    toMs: number,
  ): Promise<readonly ChartBar[]>;
}

/** Bars from this platform's own API. */
export function createPlatformDatafeed(api: ApiClient): ChartDatafeed {
  return {
    history: (symbol, resolution, fromMs, toMs) =>
      api.get<ChartBar[]>('/market/candles', {
        query: { symbol, resolution, from: fromMs, to: toMs },
      }),
  };
}

/**
 * Live bars win over stored bars for the same bucket.
 *
 * The REST rows were true when they were fetched; a bar the socket has since
 * updated is more recent. Merging on bar time rather than appending means a
 * refetch that overlaps the live window cannot produce two bars for one minute —
 * which on a chart looks like a price that moved twice.
 */
export function mergeBars(
  history: readonly ChartBar[],
  live: Record<number, ChartBar> | undefined,
): ChartBar[] {
  const merged = new Map<number, ChartBar>();
  for (const bar of history) merged.set(bar.time, bar);
  for (const bar of Object.values(live ?? {})) merged.set(bar.time, bar);
  return [...merged.values()].sort((a, b) => a.time - b.time);
}
