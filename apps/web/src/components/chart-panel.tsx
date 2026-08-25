'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@tp/ui';
import { price as formatPrice } from '@/lib/format';
import { RESOLUTIONS, RESOLUTION_LABEL, mergeBars, type ChartBar } from '@/lib/datafeed';
import { useCandles, type SymbolRow } from '@/lib/queries';
import { barKey, useRealtime } from '@/lib/realtime-store';
import { EmptyState } from './primitives';

/**
 * Price history.
 *
 * Bars come from the server's own candles, with the in-progress bar merged in
 * from the `candle.update` stream. Nothing here is synthesised: when the server
 * has no bars for a window the panel says so rather than drawing a plausible
 * line.
 *
 * Rendered with `lightweight-charts` (Apache-2.0), behind the datafeed boundary
 * in `lib/datafeed.ts`. TradingView Advanced Charts — indicators, drawing tools,
 * order-from-chart — is licensed and not in this repository; its adapter is
 * written and tested in `lib/tradingview-datafeed.ts` and drops in without an
 * engine, API or WebSocket change. See docs/charting.md.
 */
export function ChartPanel({
  symbol,
  resolution,
  onResolutionChange,
}: {
  symbol: SymbolRow | undefined;
  resolution: string;
  onResolutionChange: (resolution: string) => void;
}) {
  const history = useCandles(symbol?.code ?? null, resolution);
  const liveBars = useRealtime((state) =>
    symbol === undefined ? undefined : state.bars[barKey(symbol.code, resolution)],
  );
  const quote = useRealtime((state) =>
    symbol === undefined ? undefined : state.quotes[symbol.code],
  );

  const bars = useMemo(
    () => mergeBars((history.data ?? []) as ChartBar[], liveBars as Record<number, ChartBar>),
    [history.data, liveBars],
  );

  const empty = !history.isLoading && bars.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-terminal-border px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-terminal-text">{symbol?.code ?? '—'}</span>
          <span className="numeric text-xs text-terminal-muted">
            {quote === undefined || symbol === undefined
              ? ''
              : formatPrice(quote.bid, symbol.pricePrecision)}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {RESOLUTIONS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onResolutionChange(value)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                value === resolution
                  ? 'bg-terminal-raised text-terminal-text'
                  : 'text-terminal-muted hover:text-terminal-text',
              )}
            >
              {RESOLUTION_LABEL[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {symbol === undefined ? (
          <EmptyState>Select an instrument.</EmptyState>
        ) : (
          <>
            <Candles bars={bars} spec={symbol} />
            {history.isLoading ? (
              <Overlay>Loading bars…</Overlay>
            ) : empty ? (
              <Overlay>
                No bars recorded for {symbol.code} at {RESOLUTION_LABEL[resolution]} in this window.
              </Overlay>
            ) : null}
          </>
        )}
      </div>

      <p className="shrink-0 border-t border-terminal-border px-3 py-1 text-[10px] text-terminal-muted">
        Server candles, built from the bid. Indicators, drawing tools and order-from-chart arrive
        with the licensed charting library.
      </p>
    </div>
  );
}

/** Below this, stretching the series to fill the panel misrepresents the market. */
const MIN_BARS_TO_FIT = 60;
const DEFAULT_BAR_SPACING = 8;

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-terminal-surface/80 text-center text-xs text-terminal-muted">
      {children}
    </div>
  );
}

/**
 * The chart surface.
 *
 * Created once and then fed. Recreating it on every data change would throw away
 * the trader's pan and zoom on every tick, which on a live chart is the
 * difference between a tool and a slideshow.
 */
function Candles({ bars, spec }: { bars: readonly ChartBar[]; spec: SymbolRow }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Which series is on screen, so a symbol or resolution change resets the view
  // and a new bar does not.
  const seriesKeyRef = useRef<string>('');

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b94a3',
        fontFamily:
          "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#232a35' },
        horzLines: { color: '#232a35' },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#232a35' },
      timeScale: {
        borderColor: '#232a35',
        // Intraday bars are meaningless without the time of day on the axis.
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      seriesKeyRef.current = '';
    };
  }, []);

  // Price formatting follows the instrument, so gold does not render to five
  // decimals and a currency pair does not round away four of them.
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: {
        type: 'price',
        precision: spec.pricePrecision,
        minMove: Number(spec.tickSize),
      },
    });
  }, [spec.pricePrecision, spec.tickSize, spec.code]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (series === null || chart === null) return;

    series.setData(bars.map(toCandlestickData));

    const key = `${spec.code}:${bars.length === 0 ? '' : String(bars[0]?.time)}`;
    if (seriesKeyRef.current === key) return;
    seriesKeyRef.current = key;

    // `fitContent` spreads whatever exists across the full width, so a fresh
    // instance with three bars draws three enormous blocks and reads as a market
    // that moves in steps. Below a screenful, hold a normal bar width and sit at
    // the right edge instead — the same view, honestly scaled, with room for the
    // bars still to come.
    if (bars.length >= MIN_BARS_TO_FIT) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().applyOptions({ barSpacing: DEFAULT_BAR_SPACING });
      chart.timeScale().scrollToRealTime();
    }
  }, [bars, spec.code]);

  return <div ref={containerRef} className="h-full w-full" />;
}

/**
 * Prices become JS numbers here, at the rendering boundary and nowhere else.
 *
 * A chart coordinate is not money: it cannot flow back into an order, and the
 * decimal string it came from is still what any request would carry. The time
 * axis takes seconds, while every bar on the wire is in milliseconds.
 */
function toCandlestickData(bar: ChartBar): CandlestickData<UTCTimestamp> {
  return {
    time: Math.floor(bar.time / 1000) as UTCTimestamp,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
  };
}
