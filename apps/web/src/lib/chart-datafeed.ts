'use client';

import type { ApiClient } from '@tp/api-client';
import { createPlatformDatafeed, type ChartBar } from '@tp/chart-core';
import { useRealtime, barKey } from './realtime-store';
import {
  createTradingViewDatafeed,
  type LiveBarSource,
  type PlatformDatafeedDeps,
} from './tradingview-datafeed';
import type { SymbolRow, TradingSession } from './queries';

/**
 * The reading half of the chart seam, assembled.
 *
 * `tradingview-datafeed.ts` holds the mappings and the datafeed object; this
 * holds the wiring that turns this application's own state into the four
 * dependencies it asks for. Splitting them that way keeps the mappings pure and
 * testable, and keeps the parts that touch React and zustand out of them.
 *
 * The licensed charting bundle is not in this repository, so nothing renders
 * from this yet — but the object it builds is exercised end to end by
 * `chart-datafeed.test.ts` against the real store and a stub API, which is the
 * difference between an adapter that has been written and one that has been
 * shown to work. When the bundle lands, this is what `new TradingView.widget`
 * is handed. See docs/charting.md.
 */

/**
 * Live bars, read out of the realtime store.
 *
 * The store is where the `candle.update` frames land. Subscribing to it rather
 * than to the socket directly means one subscription feeds both charts, and a
 * chart that mounts halfway through a bar sees the bar as it stands instead of
 * waiting for the next frame.
 *
 * Only *newer* bars are delivered. zustand notifies on every store change, and
 * without the time check a quote arriving would re-emit the bar the chart
 * already has — harmless for the renderer and wasteful several times a second.
 */
export function storeBarSource(): LiveBarSource {
  return {
    subscribe(symbol, resolution, onBar) {
      const key = barKey(symbol, resolution);
      let lastTime = -1;
      let lastClose = '';

      return useRealtime.subscribe((state) => {
        const bucket = state.bars[key];
        if (bucket === undefined) return;

        let newest: ChartBar | undefined;
        for (const bar of Object.values(bucket)) {
          if (newest === undefined || bar.time > newest.time) newest = bar;
        }
        if (newest === undefined) return;
        // A bar that is neither newer nor changed is the same bar again.
        if (newest.time < lastTime) return;
        if (newest.time === lastTime && newest.close === lastClose) return;

        lastTime = newest.time;
        lastClose = newest.close;
        onBar(newest);
      });
    },
  };
}

export interface ChartDatafeedSources {
  api: ApiClient;
  /** The instruments currently known. Read on each call, never captured. */
  symbols: () => readonly SymbolRow[];
  /** The trading session for one instrument, or `null` if not loaded. */
  sessionFor: (code: string) => TradingSession | null;
}

/**
 * Builds the datafeed the charting library is handed.
 *
 * `serverTimeSeconds` is the browser's clock, and that is a known
 * approximation rather than an oversight: the library uses it only to decide
 * where "now" sits on the time axis. Nothing priced, filled or settled is
 * decided from it — every one of those uses the server's clock, on the server.
 */
export function buildChartDatafeed(sources: ChartDatafeedSources) {
  const deps: PlatformDatafeedDeps = {
    datafeed: createPlatformDatafeed(sources.api),
    symbols: sources.symbols,
    sessionFor: sources.sessionFor,
    live: storeBarSource(),
    serverTimeSeconds: () => Math.floor(Date.now() / 1000),
  };
  return createTradingViewDatafeed(deps);
}
