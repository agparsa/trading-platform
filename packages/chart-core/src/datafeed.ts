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

/**
 * The resolution vocabulary is `@tp/market-core`'s. This package used to carry
 * its own six-entry copy captioned "must match CANDLE_RESOLUTIONS on the
 * server"; it did not — the server knew seven — and a caption is not a check.
 * Re-exported here so the web and the phone keep one import path.
 */
export { RESOLUTIONS, RESOLUTION_LABEL, isResolution, type Resolution } from '@tp/market-core';
import {
  RESOLUTIONS as ALL,
  resolutionMs as msOf,
  isResolution as known,
  type Resolution,
} from '@tp/market-core';

/** Minutes per bar, for every resolution the platform knows. */
export const RESOLUTION_MINUTES: Readonly<Record<string, number>> = Object.fromEntries(
  ALL.map((resolution) => [resolution, msOf(resolution) / 60_000]),
);

/** Milliseconds one bar spans. Unknown resolutions fall back to one minute. */
export function resolutionMs(resolution: string): number {
  return known(resolution) ? msOf(resolution) : 60_000;
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
  /**
   * The resolutions this deployment serves — what a chart may offer. The
   * platform's vocabulary is `RESOLUTIONS`; a deployment aggregates a subset
   * of it, and a timeframe button outside that subset opens an empty chart.
   */
  resolutions(): Promise<readonly Resolution[]>;
}

/** Bars from this platform's own API. */
export function createPlatformDatafeed(api: ApiClient): ChartDatafeed {
  return {
    history: (symbol, resolution, fromMs, toMs) =>
      api.get<ChartBar[]>('/market/candles', {
        query: { symbol, resolution, from: fromMs, to: toMs },
      }),
    resolutions: async () =>
      (await api.get<{ resolutions: Resolution[] }>('/market/resolutions')).resolutions,
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
