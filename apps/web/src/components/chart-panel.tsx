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
import { price as formatPrice, signedMoney, toneClass, toneOf } from '@/lib/format';
import {
  RESOLUTIONS,
  RESOLUTION_LABEL,
  isResolution,
  mergeBars,
  rangeOf,
  type ChartBar,
} from '@tp/chart-core';
import {
  LevelKind,
  levelIdentity,
  draftLevel,
  halfVolume,
  levelsFor,
  riskReward,
  stackChips,
  outcomeAt,
  pendingLevelsFor,
  priceFromDrag,
  priceFromPendingDrag,
  type ChartLevel,
} from '@/lib/chart-levels';
import { useTradingCommands } from '@/lib/chart-commands';
import { documentPalette, levelColour } from '@/lib/chart-theme';
import { useThemeVersion } from '@/lib/use-theme';
import {
  useCandles,
  useResolutions,
  type PendingOrderRow,
  type PositionRow,
  type SymbolRow,
  useClosePosition,
} from '@/lib/queries';
import { barKey, useRealtime } from '@/lib/realtime-store';
import { EmptyState } from './primitives';
import { useT } from '@/lib/use-locale';
import { useToasts } from '@/lib/toasts';

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
  compact = false,
}: {
  /**
   * The phone's chart: the screen's own header already names the instrument,
   * so this one shows the range on screen and the timeframes, which scroll,
   * and drops the caption a phone has no room to keep reading.
   */
  compact?: boolean;
  symbol: SymbolRow | undefined;
  resolution: string;
  onResolutionChange: (resolution: string) => void;
  positions: readonly PositionRow[];
  pendingOrders: readonly PendingOrderRow[];
  accountId: string | null;
  currency: string;
}) {
  const history = useCandles(symbol?.code ?? null, resolution);
  const served = useResolutions();
  const t = useT();
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
  const range = useMemo(() => (compact ? rangeOf(bars) : null), [compact, bars]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-terminal-border px-3 py-1.5">
        {compact ? (
          <span className="numeric shrink-0 text-caption" data-testid="chart-range">
            {range === null ? null : (
              <>
                <span className="text-terminal-muted">{t('chart.high')} </span>
                <span className="text-terminal-long">{range.high}</span>
                <span className="text-terminal-muted"> {t('chart.low')} </span>
                <span className="text-terminal-short">{range.low}</span>
              </>
            )}
          </span>
        ) : (
          <div className="flex items-center gap-2">
            {symbol === undefined ? null : (
              <span
                aria-hidden
                title={markFor(symbol.code).label}
                className={cn(
                  'inline-flex h-5 w-7 shrink-0 items-center justify-center rounded text-caption font-semibold leading-none ring-1 ring-inset',
                  markClasses(markFor(symbol.code).kind),
                )}
              >
                {markFor(symbol.code).glyph}
              </span>
            )}
            <span className="text-sm font-medium text-terminal-text">{symbol?.code ?? '—'}</span>
            {symbol === undefined ? null : (
              <span className="text-label uppercase tracking-wider text-terminal-muted">
                {markFor(symbol.code).label}
              </span>
            )}
            <span className="numeric text-xs text-terminal-muted">
              {quote === undefined || symbol === undefined
                ? ''
                : `${currencySymbol(symbol.quoteCurrency)} ${formatPrice(quote.bid, symbol.pricePrecision)}`}
            </span>
          </div>
        )}
        <div
          className={cn(
            'flex items-center gap-0.5',
            compact && 'min-w-0 overflow-x-auto [scrollbar-width:none]',
          )}
        >
          {(served.data ?? RESOLUTIONS).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onResolutionChange(value)}
              className={cn(
                'shrink-0 rounded px-2 py-0.5 text-caption transition-colors',
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
          <EmptyState>{t('ticket.selectOne')}</EmptyState>
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
              <Overlay>{t('chart.loading')}</Overlay>
            ) : empty ? (
              <Overlay>
                {t('chart.noBars', {
                  code: symbol.code,
                  resolution: isResolution(resolution) ? RESOLUTION_LABEL[resolution] : resolution,
                })}
              </Overlay>
            ) : null}
          </>
        )}
      </div>

      {compact ? null : (
        <p className="shrink-0 border-t border-terminal-border px-3 py-1 text-label text-terminal-muted">
          {t('chart.caption')}
        </p>
      )}
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
  const t = useT();
  const onThisChart = useMemo(
    () => positions.filter((position) => position.symbol === spec.code),
    [positions, spec.code],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Which series is on screen, so a symbol or resolution change resets the view
  // and a new bar does not.
  const seriesKeyRef = useRef<string>('');

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const palette = documentPalette();
    const chart = createChart(container, {
      layout: {
        background: { color: 'transparent' },
        textColor: palette.text,
        fontFamily:
          "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: palette.grid },
      timeScale: {
        borderColor: palette.grid,
        // Intraday bars are meaningless without the time of day on the axis.
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
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

  /**
   * The theme changed: repaint in its colours. The chart draws on a canvas and
   * cannot see the stylesheet, so it is told.
   */
  const themeVersion = useThemeVersion();
  const palette = useMemo(
    () => documentPalette(),
    // Re-read when the theme changes; the version is the only signal.
    [themeVersion],
  );
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (chart === null || series === null) return;
    chart.applyOptions({
      layout: { textColor: palette.text },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.grid },
      timeScale: { borderColor: palette.grid },
    });
    series.applyOptions({
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });
  }, [palette]);

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
  /**
   * Stops and targets the trader asked for from a position's panel and has not
   * yet placed — drawn, draggable, and sent only when released. A draft whose
   * position already has that level from the server is not drawn: the server's
   * line is the one to move.
   */
  const [drafts, setDrafts] = useState<Record<string, ChartLevel>>({});
  /**
   * A level released and sent, until the server answers. Drawn where it was
   * dropped, marked as waiting; on success the server's own value replaces it,
   * and on refusal it disappears and the confirmed line is where it always was.
   */
  const [pending, setPending] = useState<{ key: string; level: ChartLevel; price: string } | null>(
    null,
  );
  const levels = useMemo(() => {
    const confirmed = [
      ...levelsFor(positions, spec.code),
      ...pendingLevelsFor(pendingOrders, spec.code, spec, quote),
    ];
    const taken = new Set(confirmed.map(levelIdentity));
    const open = new Set(positions.map((position) => position.id));
    const drafted = Object.values(drafts).filter(
      (draft) =>
        !taken.has(levelIdentity(draft)) && draft.positionId !== null && open.has(draft.positionId),
    );
    return [...confirmed, ...drafted];
  }, [positions, pendingOrders, spec, quote, drafts]);
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
          color: levelColour(level.kind, palette),
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
      // With both levels set, what the move does to the trade's shape: the
      // money at risk, the money in view, and their ratio — from the same
      // arithmetic as the line labels, so the three can never disagree.
      const shape =
        position === undefined || drag.level.kind === LevelKind.PENDING
          ? null
          : riskReward(position, spec, drag.level.kind, drag.price, currency);
      linesRef.current.set(
        'preview',
        series.createPriceLine({
          price: Number(drag.price),
          color: drag.error === null ? palette.pending : palette.down,
          lineWidth: 2,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title:
            drag.error !== null
              ? drag.error
              : [
                  `→ ${drag.price}`,
                  proposed === null ? null : signedMoney(proposed, currency),
                  shape === null ? null : `R:R ${shape.ratio}`,
                ]
                  .filter((part) => part !== null)
                  .join('  '),
        }),
      );
    }

    // Sent and not yet answered: where it was dropped, marked as waiting.
    if (pending !== null) {
      linesRef.current.set(
        'pending',
        series.createPriceLine({
          price: Number(pending.price),
          color: palette.pending,
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title:
            `… ${pending.level.kind === LevelKind.TAKE_PROFIT ? 'TP' : pending.level.kind === LevelKind.STOP_LOSS ? 'SL' : ''} ${pending.price}`.replace(
              '  ',
              ' ',
            ),
        }),
      );
    }

    return () => {
      for (const line of linesRef.current.values()) series.removePriceLine(line);
      linesRef.current.clear();
    };
  }, [levels, drag, pending, byId, spec, currency, palette]);

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
  /**
   * Sends a level — dropped by a drag, or placed from a position's panel.
   *
   * The round trip. Nothing confirmed moves until the server says so: the
   * sent value is drawn as waiting, on success the server's own value
   * arrives through the position query and the `position.updated` frame, and
   * on refusal the waiting line goes and the confirmed one is where it always
   * was — with the server's reason on screen.
   */
  const submitLevel = useCallback(
    (level: ChartLevel, price: string) => {
      const key = levelIdentity(level);
      const sent =
        level.kind === LevelKind.PENDING
          ? level.orderId === null
            ? null
            : commands.movePendingOrder(level.orderId, price)
          : level.positionId === null
            ? null
            : commands.modifyPositionLevel(level.positionId, level.kind, price);
      if (sent === null) return;
      const forget = () => {
        if (level.draft !== true) return;
        setDrafts((now) => {
          const next = { ...now };
          delete next[key];
          return next;
        });
      };
      setRefusal(null);
      setPending({ key, level, price });
      sent
        // The server's value is the line now; a draft has done its job.
        .then(forget)
        .catch((error: unknown) => {
          // A draft goes too: it was never a level the server accepted.
          forget();
          setRefusal(error instanceof Error ? error.message : t('chart.refused'));
        })
        .finally(() => setPending(null));
    },
    [commands, t],
  );

  const hasTarget = useCallback(
    (level: ChartLevel): boolean =>
      level.kind === LevelKind.PENDING
        ? level.orderId !== null && ordersById[level.orderId] !== undefined
        : level.positionId !== null && byId[level.positionId] !== undefined,
    [byId, ordersById],
  );

  const levelUnder = useCallback(
    (offsetY: number, radius: number = GRAB_RADIUS_PX): ChartLevel | null => {
      const series = seriesRef.current;
      if (series === null) return null;
      let nearest: { level: ChartLevel; distance: number } | null = null;
      for (const level of levels) {
        if (!level.draggable) continue;
        const y = series.priceToCoordinate(Number(level.price));
        if (y === null) continue;
        const distance = Math.abs(y - offsetY);
        if (distance <= radius && (nearest === null || distance < nearest.distance)) {
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
      // A fingertip is not a cursor: a line six pixels tall is a target a
      // finger mostly misses, and a missed grab pans the chart instead.
      const level = levelUnder(
        yIn(event),
        event.pointerType === 'touch' ? TOUCH_GRAB_RADIUS_PX : GRAB_RADIUS_PX,
      );
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
      // Unmoved is nothing to send — a draft too: a tap that lands on its
      // line is not a decision to place it there. Its panel button is.
      if (current.price === current.level.price) return;

      submitLevel(current.level, current.price);
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
  }, [levelUnder, hasTarget, byId, ordersById, spec, quote, submitLevel]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      <PositionChips
        chartRef={chartRef}
        seriesRef={seriesRef}
        positions={onThisChart}
        accountId={accountId}
        currency={currency}
        revision={bars}
        spec={spec}
        drafts={drafts}
        waiting={pending === null ? null : pending.key}
        onPlace={submitLevel}
        onDraft={(position, kind) => {
          const draft = draftLevel(spec, position, kind, quote?.bid ?? null);
          if (draft === null) return;
          setRefusal(null);
          setDrafts((now) => ({ ...now, [levelIdentity(draft)]: draft }));
        }}
      />
      {refusal === null ? null : (
        <button
          type="button"
          onClick={() => setRefusal(null)}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-terminal-short/50 bg-terminal-surface px-3 py-1 text-caption text-terminal-short"
        >
          {refusal} — {t('pos.dismiss')}
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
/** The same, for a finger — about the 44pt minimum touch target, halved. */
const TOUCH_GRAB_RADIUS_PX = 20;

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

/**
 * Each open position on the chart, at its entry: its size, what it is making
 * now, and a button to close it — the way a trading app marks a position on
 * the price it was opened at.
 *
 * Drawn over the chart in HTML rather than inside it, so the button is a real
 * button (focusable, named, announced). Placed from the chart's own price
 * coordinate a few times a second, which follows pan, zoom and rescale
 * without listening to each. The figure is the server's, from the socket.
 *
 * Closing asks first, on the chip itself: a cross beside a moving price is the
 * easiest thing on the screen to hit by accident.
 */
function PositionChips({
  chartRef,
  seriesRef,
  positions,
  accountId,
  currency,
  revision,
  spec,
  drafts,
  waiting: sending,
  onPlace,
  onDraft,
}: {
  /** Changes when the bars do, so the chips follow the rescaled axis. */
  revision: unknown;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  positions: readonly PositionRow[];
  accountId: string | null;
  currency: string;
  spec: SymbolRow;
  /** Drafted stops and targets, by line identity. */
  drafts: Readonly<Record<string, ChartLevel>>;
  /** The line identity of a level sent and not yet answered. */
  waiting: string | null;
  /** Send a level as it stands — a draft accepted where it was drawn. */
  onPlace: (level: ChartLevel, price: string) => void;
  /** Draw a draggable stop or target for a position that has none. */
  onDraft: (
    position: PositionRow,
    kind: typeof LevelKind.STOP_LOSS | typeof LevelKind.TAKE_PROFIT,
  ) => void;
}) {
  const t = useT();
  const pnl = useRealtime((state) => state.pnl);
  const close = useClosePosition(accountId);
  const [places, setPlaces] = useState<Record<string, number | null>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /** Positions with a close on the wire: their buttons wait, so one tap is one close. */
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [scale, setScale] = useState(0);
  // A panel for a position that has gone is no panel at all.
  const expanded = positions.some((position) => position.id === opened) ? opened : null;

  /*
   * Placed again whenever what decides a line's height changes: the bars (the
   * price scale rescales to them), the visible range (pan and zoom), the
   * panel's size and the positions themselves. Event-driven, not a timer.
   */
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (series === null || chart === null) return;
    const place = () => {
      const raw: Record<string, number | null> = {};
      for (const position of positions) {
        raw[position.id] = series.priceToCoordinate(Number(position.entryPrice));
      }
      const next = stackChips(raw, CHIP_GAP_PX);
      setPlaces((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next));
      setScale(chart.priceScale('right').width());
    };
    // After the chart has drawn this change, so the scale is the new one.
    const frame = requestAnimationFrame(place);
    chart.timeScale().subscribeVisibleLogicalRangeChange(place);
    chart.subscribeCrosshairMove(place);
    return () => {
      cancelAnimationFrame(frame);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(place);
      chart.unsubscribeCrosshairMove(place);
    };
  }, [chartRef, seriesRef, positions, revision]);

  /**
   * One close, sent once. The chip stays — showing that it is waiting — until
   * the server's answer arrives and the list drops the row; a refusal is said
   * out loud rather than leaving the trader to wonder why it is still there.
   */
  const closeNow = (position: PositionRow, volume: string | null) => {
    if (closing.has(position.id)) return;
    setClosing((now) => new Set(now).add(position.id));
    setAsking(null);
    close
      .mutateAsync({ positionId: position.id, volume })
      .catch((error: unknown) =>
        useToasts.getState().push({
          id: `close-failed:${position.id}`,
          tone: 'danger',
          sticky: false,
          title: t('pos.closeFailed'),
          ...(error instanceof Error ? { body: error.message } : {}),
        }),
      )
      .finally(() =>
        setClosing((now) => {
          const next = new Set(now);
          next.delete(position.id);
          return next;
        }),
      );
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      data-testid="position-chips"
    >
      {positions.map((position) => {
        const y = places[position.id];
        if (y === null || y === undefined) return null;
        const floating = pnl[position.id]?.floatingPnl ?? null;
        const confirming = asking === position.id;
        const open = expanded === position.id;
        const waiting = closing.has(position.id);
        const half = halfVolume(spec, position);
        return (
          <div
            key={position.id}
            className={cn(
              'pointer-events-auto absolute flex flex-col overflow-hidden rounded border bg-terminal-surface text-caption shadow',
              open ? 'z-20 border-terminal-accent' : 'border-terminal-border',
            )}
            style={{ top: y, right: scale + 8, transform: 'translateY(-50%)' }}
            data-testid="position-chip"
            data-position-id={position.id}
          >
            <div className="flex items-stretch">
              <button
                type="button"
                className="flex items-stretch"
                aria-expanded={open}
                aria-label={t(
                  'chart.positionDetails',
                  { volume: position.volume, symbol: position.symbol },
                  false,
                )}
                onClick={() => setOpened(open ? null : position.id)}
                data-testid="position-chip-toggle"
              >
                <span
                  className={cn(
                    'numeric px-2 py-1 font-medium',
                    position.side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
                  )}
                >
                  {position.volume}
                </span>
                <span
                  className={cn(
                    'numeric border-s border-terminal-border px-2 py-1',
                    toneClass[toneOf(floating)],
                  )}
                >
                  {signedMoney(floating, currency)}
                </span>
              </button>
              {waiting ? (
                <span
                  className="border-s border-terminal-border px-2 py-1 text-terminal-muted"
                  role="status"
                >
                  {t('chart.closing')}
                </span>
              ) : confirming ? (
                <>
                  <button
                    type="button"
                    className="border-s border-terminal-border bg-terminal-short px-2 font-medium text-terminal-bg"
                    onClick={() => closeNow(position, null)}
                  >
                    {t('pos.close')}
                  </button>
                  <button
                    type="button"
                    className="border-s border-terminal-border px-2 text-terminal-muted"
                    onClick={() => setAsking(null)}
                  >
                    {t('wallet.cancel')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="border-s border-terminal-border px-2 text-terminal-muted hover:text-terminal-short"
                  aria-label={t('chart.closePosition', {
                    volume: position.volume,
                    symbol: position.symbol,
                  })}
                  onClick={() => setAsking(position.id)}
                >
                  ×
                </button>
              )}
            </div>
            {open ? (
              <div
                className="grid grid-cols-2 gap-1 border-t border-terminal-border p-1"
                data-testid="position-chip-panel"
              >
                <LevelButton
                  label="SL"
                  value={position.stopLoss}
                  draft={drafts[`${position.id}:${LevelKind.STOP_LOSS}`] ?? null}
                  sending={sending === `${position.id}:${LevelKind.STOP_LOSS}`}
                  onAdd={() => onDraft(position, LevelKind.STOP_LOSS)}
                  onPlace={onPlace}
                  t={t}
                />
                <LevelButton
                  label="TP"
                  value={position.takeProfit}
                  draft={drafts[`${position.id}:${LevelKind.TAKE_PROFIT}`] ?? null}
                  sending={sending === `${position.id}:${LevelKind.TAKE_PROFIT}`}
                  onAdd={() => onDraft(position, LevelKind.TAKE_PROFIT)}
                  onPlace={onPlace}
                  t={t}
                />
                {half === null ? null : (
                  <button
                    type="button"
                    disabled={waiting}
                    className="min-h-8 rounded border border-terminal-border px-2 text-terminal-text disabled:opacity-50"
                    onClick={() => closeNow(position, half)}
                    data-testid="position-chip-half"
                  >
                    {t('pos.closeVolume', { volume: half })}
                  </button>
                )}
                {/* Opening the panel was the deliberate step; this one closes. */}
                <button
                  type="button"
                  disabled={waiting}
                  className={cn(
                    'min-h-8 rounded bg-terminal-short px-2 font-medium text-terminal-bg disabled:opacity-50',
                    half === null && 'col-span-2',
                  )}
                  onClick={() => closeNow(position, null)}
                  data-testid="position-chip-close"
                >
                  {t('pos.close')}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A stop or target in a position's panel.
 *
 * Set: its value, moved by dragging its line. Drafted: the price the draft
 * line is at, and a button that places it there — the way to set one without
 * dragging, for a keyboard, a screen reader, or a thumb that would rather tap.
 * Neither: a button that draws a draft to drag into place.
 */
function LevelButton({
  label,
  value,
  draft,
  sending,
  onAdd,
  onPlace,
  t,
}: {
  label: 'SL' | 'TP';
  value: string | null;
  draft: ChartLevel | null;
  sending: boolean;
  onAdd: () => void;
  onPlace: (level: ChartLevel, price: string) => void;
  t: ReturnType<typeof useT>;
}) {
  const id = label.toLowerCase();
  if (sending) {
    return (
      <span
        className="numeric flex min-h-8 items-center rounded border border-terminal-border px-2 text-terminal-muted"
        role="status"
      >
        {label} …
      </span>
    );
  }
  if (value !== null) {
    return (
      <span
        className="numeric flex min-h-8 items-center rounded border border-terminal-border px-2 text-terminal-text"
        title={t('chart.dragToSet')}
        data-testid={`position-chip-${id}`}
      >
        {label} {value}
      </span>
    );
  }
  if (draft !== null) {
    return (
      <button
        type="button"
        className="numeric min-h-8 rounded border border-terminal-accent px-2 text-terminal-accent"
        onClick={() => onPlace(draft, draft.price)}
        title={t('chart.dragToSet')}
        data-testid={`position-chip-place-${id}`}
      >
        {t('chart.placeLevel', { label, price: draft.price })}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="min-h-8 rounded border border-dashed border-terminal-border px-2 text-terminal-text"
      onClick={onAdd}
      title={t('chart.dragToSet')}
      data-testid={`position-chip-add-${id}`}
    >
      + {label}
    </button>
  );
}

/** Chips closer than this are spread apart; about one chip's height. */
const CHIP_GAP_PX = 28;
