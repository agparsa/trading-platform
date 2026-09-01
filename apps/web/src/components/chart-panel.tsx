'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createChart,
  LineStyle,
  type CandlestickData,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@tp/ui';
import { currencySymbol, markClasses, markFor } from '@/lib/instrument-marks';
import { price as formatPrice, signedMoney } from '@/lib/format';
import { RESOLUTIONS, RESOLUTION_LABEL, mergeBars, type ChartBar } from '@tp/chart-core';
import {
  LevelKind,
  levelIdentity,
  levelsFor,
  outcomeAt,
  pendingLevelsFor,
  priceFromDrag,
  priceFromPendingDrag,
  type ChartLevel,
} from '@/lib/chart-levels';
import { useTradingCommands } from '@/lib/chart-commands';
import { useCandles, type PendingOrderRow, type PositionRow, type SymbolRow } from '@/lib/queries';
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
 * in `@tp/chart-core`. TradingView Advanced Charts — indicators, drawing tools,
 * order-from-chart — is licensed and not in this repository; its adapter is
 * written and tested in `lib/tradingview-datafeed.ts` and drops in without an
 * engine, API or WebSocket change. See docs/charting.md.
 */
export function ChartPanel({
  symbol,
  resolution,
  onResolutionChange,
  positions,
  pendingOrders,
  accountId,
  currency,
}: {
  symbol: SymbolRow | undefined;
  resolution: string;
  onResolutionChange: (resolution: string) => void;
  positions: readonly PositionRow[];
  pendingOrders: readonly PendingOrderRow[];
  accountId: string | null;
  currency: string;
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
        <div className="flex items-center gap-2">
          {symbol === undefined ? null : (
            <span
              aria-hidden
              title={markFor(symbol.code).label}
              className={cn(
                'inline-flex h-5 w-7 shrink-0 items-center justify-center rounded text-[11px] font-semibold leading-none ring-1 ring-inset',
                markClasses(markFor(symbol.code).kind),
              )}
            >
              {markFor(symbol.code).glyph}
            </span>
          )}
          <span className="text-sm font-medium text-terminal-text">{symbol?.code ?? '—'}</span>
          {symbol === undefined ? null : (
            <span className="text-[10px] uppercase tracking-wider text-terminal-muted">
              {markFor(symbol.code).label}
            </span>
          )}
          <span className="numeric text-xs text-terminal-muted">
            {quote === undefined || symbol === undefined
              ? ''
              : `${currencySymbol(symbol.quoteCurrency)} ${formatPrice(quote.bid, symbol.pricePrecision)}`}
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
            <Candles
              bars={bars}
              spec={symbol}
              positions={positions}
              pendingOrders={pendingOrders}
              accountId={accountId}
              currency={currency}
            />
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
        Server candles, built from the bid. Drag a stop, a target or a resting order to move it —
        the server decides. Indicators and drawing tools arrive with the licensed charting library.
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
function Candles({
  bars,
  spec,
  positions,
  pendingOrders,
  accountId,
  currency,
}: {
  bars: readonly ChartBar[];
  spec: SymbolRow;
  positions: readonly PositionRow[];
  pendingOrders: readonly PendingOrderRow[];
  accountId: string | null;
  currency: string;
}) {
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

  // ─── Levels ────────────────────────────────────────────────────────────────

  /**
   * Trading actions go through the command adapter, not through mutations
   * reached for here.
   *
   * That is the writing half of the seam `lib/tradingview-datafeed.ts` opened
   * for reading: when the licensed library arrives it is handed this same
   * object, and the chart that issues the command changes without the commands
   * themselves changing. See lib/chart-commands.ts.
   */
  const commands = useTradingCommands(accountId);
  const quote = useRealtime((state) => state.quotes[spec.code]);
  const levels = useMemo(
    () => [
      ...levelsFor(positions, spec.code),
      ...pendingLevelsFor(pendingOrders, spec.code, spec, quote),
    ],
    [positions, pendingOrders, spec, quote],
  );
  const byId = useMemo(
    () => Object.fromEntries(positions.map((position) => [position.id, position])),
    [positions],
  );
  const ordersById = useMemo(
    () => Object.fromEntries(pendingOrders.map((order) => [order.orderId, order])),
    [pendingOrders],
  );

  /**
   * The line being dragged, if any, and what it would mean.
   *
   * This is a *preview*. The drawn levels are the server's values and are never
   * moved from here — which is why a rejected modification needs no revert:
   * nothing authoritative was moved to begin with.
   */
  const [drag, setDrag] = useState<DragState | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const linesRef = useRef<Map<string, IPriceLine>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  /**
   * Keep the drawn levels inside the visible price range.
   *
   * A stop drawn off the top or bottom of the chart is a stop the trader can
   * neither see nor grab — and it is precisely the stop they most want to look
   * at, because it is far from the market. The autoscale range is widened to
   * include every level rather than only the bars, so a position's protection
   * is always on screen.
   *
   * The bars' own range is still the floor: this only ever widens.
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    const prices = levels.map((level) => Number(level.price)).filter(Number.isFinite);

    series.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const base = original();
        if (prices.length === 0) return base;
        const candidates = [...prices];
        if (base?.priceRange != null) {
          candidates.push(base.priceRange.minValue, base.priceRange.maxValue);
        }
        return {
          priceRange: { minValue: Math.min(...candidates), maxValue: Math.max(...candidates) },
          ...(base?.margins === undefined ? {} : { margins: base.margins }),
        };
      },
    });
  }, [levels]);

  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;

    // Rebuilt wholesale on every change. A price line has no mutable price in
    // this library, and a handful of lines is nothing to redraw — trying to
    // diff them would be more code guarding a smaller cost.
    for (const line of linesRef.current.values()) series.removePriceLine(line);
    linesRef.current.clear();

    for (const level of levels) {
      const position = level.positionId === null ? undefined : byId[level.positionId];
      /**
       * Always the outcome at *this line's own* price.
       *
       * Showing the dragged price's outcome here instead is tempting and wrong:
       * the line would read "TP 4640.98  +$295.90" while 295.90 is what 4647.64
       * would pay. A label whose two halves refer to different prices is how
       * somebody misreads their own risk. The proposed number belongs on the
       * preview, next to the proposed price.
       */
      const outcome =
        position === undefined || level.kind === LevelKind.ENTRY || level.kind === LevelKind.PENDING
          ? null
          : outcomeAt(position, spec, level.price, currency);

      linesRef.current.set(
        levelIdentity(level),
        series.createPriceLine({
          price: Number(level.price),
          color: LEVEL_COLOR[level.kind],
          lineWidth: 1,
          lineStyle: level.kind === LevelKind.ENTRY ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title:
            outcome === null ? level.title : `${level.title}  ${signedMoney(outcome, currency)}`,
        }),
      );
    }

    // The preview, drawn beside the real one rather than instead of it, so the
    // trader can see both where the stop is and where they are proposing to put
    // it.
    if (drag !== null) {
      const position = drag.level.positionId === null ? undefined : byId[drag.level.positionId];
      const proposed =
        position === undefined || drag.level.kind === LevelKind.PENDING
          ? null
          : outcomeAt(position, spec, drag.price, currency);
      linesRef.current.set(
        'preview',
        series.createPriceLine({
          price: Number(drag.price),
          color: drag.error === null ? '#e0b341' : '#ef5350',
          lineWidth: 2,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title:
            drag.error !== null
              ? drag.error
              : proposed === null
                ? `→ ${drag.price}`
                : `→ ${drag.price}  ${signedMoney(proposed, currency)}`,
        }),
      );
    }

    return () => {
      for (const line of linesRef.current.values()) series.removePriceLine(line);
      linesRef.current.clear();
    };
  }, [levels, drag, byId, spec, currency]);

  /**
   * Which level, if any, is under the pointer.
   *
   * Within a few pixels rather than exactly on the line: a 1px hit target is
   * unusable, and a stop that is hard to grab is a stop that gets left where it
   * is.
   */
  /**
   * Is the thing this line describes still there?
   *
   * A position closed by a stop-out, or an order that just filled, leaves its
   * line on screen for the instant between the server acting and the query
   * refetching. Grabbing it in that instant would send a modification for
   * something that no longer exists.
   */
  const hasTarget = useCallback(
    (level: ChartLevel): boolean =>
      level.kind === LevelKind.PENDING
        ? level.orderId !== null && ordersById[level.orderId] !== undefined
        : level.positionId !== null && byId[level.positionId] !== undefined,
    [byId, ordersById],
  );

  const levelUnder = useCallback(
    (offsetY: number): ChartLevel | null => {
      const series = seriesRef.current;
      if (series === null) return null;
      let nearest: { level: ChartLevel; distance: number } | null = null;
      for (const level of levels) {
        if (!level.draggable) continue;
        const y = series.priceToCoordinate(Number(level.price));
        if (y === null) continue;
        const distance = Math.abs(y - offsetY);
        if (distance <= GRAB_RADIUS_PX && (nearest === null || distance < nearest.distance)) {
          nearest = { level, distance };
        }
      }
      return nearest?.level ?? null;
    },
    [levels],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    /**
     * Where the pointer is, measured against the chart container.
     *
     * Deliberately not `event.offsetY`, which is relative to whatever element
     * the pointer happens to be over — and the library draws several canvases
     * inside this container. The price scale is one of them, so `offsetY` would
     * silently change origin as the cursor crossed into it and the level under
     * the pointer would be computed from a different zero.
     */
    const yIn = (event: PointerEvent): number =>
      event.clientY - container.getBoundingClientRect().top;

    const priceAt = (y: number): number | null => {
      const value = seriesRef.current?.coordinateToPrice(y);
      return value === null || value === undefined ? null : Number(value);
    };

    const onPointerDown = (event: PointerEvent) => {
      const level = levelUnder(yIn(event));
      if (level === null) return;
      // The row behind the line has to still exist. A line whose position or
      // order has just closed is a line about to disappear, and dragging it
      // would send a modification for something that is gone.
      if (!hasTarget(level)) return;

      // Stops the chart panning under the drag; without this the price scale
      // moves with the cursor and the level appears not to follow it.
      event.preventDefault();
      event.stopPropagation();
      container.setPointerCapture(event.pointerId);
      chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
      setRefusal(null);
      setDrag({ key: levelIdentity(level), level, price: level.price, error: null });
    };

    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null) {
        container.style.cursor = levelUnder(yIn(event)) === null ? '' : 'ns-resize';
        return;
      }
      const raw = priceAt(yIn(event));
      if (raw === null) return;

      if (current.level.kind === LevelKind.PENDING) {
        const order =
          current.level.orderId === null ? undefined : ordersById[current.level.orderId];
        if (order === undefined) return;
        const moved = priceFromPendingDrag(spec, order, raw, quote);
        setDrag({ ...current, price: moved.price, error: moved.error });
        return;
      }

      const position =
        current.level.positionId === null ? undefined : byId[current.level.positionId];
      if (position === undefined) return;
      const outcome = priceFromDrag(
        spec,
        position,
        current.level.kind,
        raw,
        quote?.bid ?? position.currentPrice,
      );
      setDrag({ ...current, price: outcome.price, error: outcome.error });
    };

    const endDrag = (event: PointerEvent) => {
      const current = dragRef.current;
      chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      if (current === null) return;
      setDrag(null);

      if (current.error !== null) {
        setRefusal(current.error);
        return;
      }
      if (current.price === current.level.price) return;

      /**
       * The round trip. Nothing on screen has moved yet and nothing will until
       * the server says so: on success the new value arrives through the
       * position query and the `position.updated` frame, and on failure the
       * line is already where it always was.
       */
      const sent =
        current.level.kind === LevelKind.PENDING
          ? current.level.orderId === null
            ? null
            : commands.movePendingOrder(current.level.orderId, current.price)
          : current.level.positionId === null
            ? null
            : commands.modifyPositionLevel(
                current.level.positionId,
                current.level.kind,
                current.price,
              );

      sent?.catch((error: unknown) =>
        setRefusal(error instanceof Error ? error.message : 'The server refused that level.'),
      );
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', endDrag);
      container.removeEventListener('pointercancel', endDrag);
    };
  }, [levelUnder, hasTarget, byId, ordersById, spec, quote, commands]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {refusal === null ? null : (
        <button
          type="button"
          onClick={() => setRefusal(null)}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-terminal-short/50 bg-terminal-surface px-3 py-1 text-[11px] text-terminal-short"
        >
          {refusal} — dismiss
        </button>
      )}
    </div>
  );
}

interface DragState {
  key: string;
  level: ChartLevel;
  price: string;
  error: string | null;
}

/** Within this many pixels counts as grabbing the line. A 1px target is unusable. */
const GRAB_RADIUS_PX = 6;

const LEVEL_COLOR: Record<LevelKind, string> = {
  [LevelKind.ENTRY]: '#8b94a3',
  [LevelKind.STOP_LOSS]: '#ef5350',
  [LevelKind.TAKE_PROFIT]: '#26a69a',
  // Its own colour, because it is its own kind of thing: an instruction that
  // will *open* a trade, not one that closes an existing one.
  [LevelKind.PENDING]: '#e0b341',
};

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
