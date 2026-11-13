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
  editChanges,
  editErrors,
  editFrom,
  halfVolume,
  levelsFor,
  riskReward,
  stackChips,
  outcomeAt,
  pendingLevelsFor,
  priceFromDrag,
  priceFromPendingDrag,
  type ChartLevel,
  type LevelEdit,
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
  useModifyPosition,
} from '@/lib/queries';
import { barKey, useRealtime } from '@/lib/realtime-store';
import { EmptyState, inputClass } from './primitives';
import { useT } from '@/lib/use-locale';
import { useStale } from '@/lib/use-stale';
import { useToasts } from '@/lib/toasts';
import { playTradeSound } from '@/lib/trade-sounds';

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
  const stale = useStale(quote?.timestamp, quote !== undefined && symbol?.sessionOpen === true);

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
            {stale ? (
              <span
                className="rounded bg-terminal-warning/15 px-1 text-micro uppercase tracking-wider text-terminal-warning"
                title={t('quote.staleTitle')}
                data-testid="quote-stale"
              >
                {t('quote.stale')}
              </span>
            ) : null}
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
   * A level released and sent, until the server answers. Drawn where it was
   * dropped, marked as waiting; on success the server's own value replaces it,
   * and on refusal it disappears and the confirmed line is where it always was.
   */
  const [pending, setPending] = useState<{ key: string; level: ChartLevel; price: string } | null>(
    null,
  );
  const byId = useMemo(
    () => Object.fromEntries(positions.map((position) => [position.id, position])),
    [positions],
  );
  /**
   * The position whose stop and target are open in the editor, and the values
   * typed or dragged there. Nothing here is sent until Save; until then the
   * chart draws these values in place of the position's own, marked as
   * unsaved, and dragging those lines changes the fields rather than the
   * position.
   */
  const [editing, setEditing] = useState<{ positionId: string; edit: LevelEdit } | null>(null);
  const editedPosition = editing === null ? undefined : byId[editing.positionId];
  // A position that has gone takes its editor with it.
  const edit = editedPosition === undefined ? null : (editing?.edit ?? null);
  const dirty =
    editedPosition !== undefined &&
    edit !== null &&
    Object.keys(editChanges(editedPosition, edit)).length > 0;

  const levels = useMemo(() => {
    const confirmed = [
      ...levelsFor(positions, spec.code),
      ...pendingLevelsFor(pendingOrders, spec.code, spec, quote),
    ];
    if (editedPosition === undefined || edit === null) return confirmed;
    const id = editedPosition.id;
    const kept = confirmed.filter(
      (level) =>
        level.positionId !== id ||
        (level.kind !== LevelKind.STOP_LOSS && level.kind !== LevelKind.TAKE_PROFIT),
    );
    const changes = editChanges(editedPosition, edit);
    const drawn: ChartLevel[] = [];
    for (const [kind, field, label] of [
      [LevelKind.STOP_LOSS, 'stopLoss', 'SL'],
      [LevelKind.TAKE_PROFIT, 'takeProfit', 'TP'],
    ] as const) {
      const text = edit[field].trim();
      if (!/^\d+(\.\d+)?$/.test(text)) continue;
      const unsaved = field in changes;
      drawn.push({
        positionId: id,
        orderId: null,
        kind,
        price: text,
        draggable: true,
        trailing: false,
        title: `${label} ${text}${unsaved ? ' •' : ''}`,
        ...(unsaved ? { draft: true as const } : {}),
      });
    }
    return [...kept, ...drawn];
  }, [positions, pendingOrders, spec, quote, editedPosition, edit]);
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
  const editRef = useRef({ editing, dirty });
  editRef.current = { editing, dirty };
  /** Opens the editor on a position — unless another one has unsaved changes. */
  const openEditor = useCallback(
    (position: PositionRow) => {
      const now = editRef.current;
      if (now.editing !== null && now.dirty && now.editing.positionId !== position.id) return;
      setRefusal(null);
      setEditing((current) =>
        current !== null && current.positionId === position.id
          ? current
          : { positionId: position.id, edit: editFrom(position, spec.pricePrecision) },
      );
    },
    [spec.pricePrecision],
  );

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
      setRefusal(null);
      setPending({ key, level, price });
      sent
        .catch((error: unknown) => {
          playTradeSound('order_rejected', `level-refused:${key}:${Date.now()}`);
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
      if (level === null) {
        // A tap on a position's entry line opens its editor; a tap anywhere
        // else closes an editor with nothing unsaved in it.
        const y = yIn(event);
        const series = seriesRef.current;
        const radius = event.pointerType === 'touch' ? TOUCH_GRAB_RADIUS_PX : GRAB_RADIUS_PX;
        const entry =
          series === null
            ? undefined
            : levels.find((candidate) => {
                if (candidate.kind !== LevelKind.ENTRY || candidate.positionId === null) {
                  return false;
                }
                const at = series.priceToCoordinate(Number(candidate.price));
                return at !== null && Math.abs(at - y) <= radius;
              });
        const position =
          entry === undefined || entry.positionId === null ? undefined : byId[entry.positionId];
        if (position !== undefined) {
          openEditor(position);
          return;
        }
        if (editRef.current.editing !== null && !editRef.current.dirty) setEditing(null);
        return;
      }
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

      // A line of the position being edited moves the editor's field, not
      // the position: Save sends it, with the other field, in one request.
      const open = editRef.current.editing;
      if (
        open !== null &&
        current.level.positionId === open.positionId &&
        (current.level.kind === LevelKind.STOP_LOSS || current.level.kind === LevelKind.TAKE_PROFIT)
      ) {
        const field = current.level.kind === LevelKind.STOP_LOSS ? 'stopLoss' : 'takeProfit';
        setEditing({ ...open, edit: { ...open.edit, [field]: current.price } });
        return;
      }

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
  }, [levelUnder, hasTarget, byId, ordersById, spec, quote, submitLevel, levels, openEditor]);

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
        editingId={editedPosition?.id ?? null}
        onOpen={openEditor}
      />
      {editedPosition === undefined || edit === null ? null : (
        <LevelEditor
          key={editedPosition.id}
          position={editedPosition}
          spec={spec}
          edit={edit}
          dirty={dirty}
          reference={quote?.bid ?? editedPosition.currentPrice}
          accountId={accountId}
          currency={currency}
          onChange={(next) => setEditing({ positionId: editedPosition.id, edit: next })}
          onDone={() => setEditing(null)}
        />
      )}
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
 * Each open position on the chart, at its entry: its size and what it is
 * making now. Tapping it opens the position's editor; × closes it, after
 * asking — a cross beside a moving price is the easiest thing on the screen
 * to hit by accident.
 *
 * Drawn over the chart in HTML rather than inside it, so the buttons are real
 * buttons (focusable, named, announced). Placed from the chart's own price
 * coordinate whenever the scale moves, and spread apart when two would
 * overlap. The figure is the server's, from the socket.
 */
function PositionChips({
  chartRef,
  seriesRef,
  positions,
  accountId,
  currency,
  revision,
  editingId,
  onOpen,
}: {
  /** Changes when the bars do, so the chips follow the rescaled axis. */
  revision: unknown;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  positions: readonly PositionRow[];
  accountId: string | null;
  currency: string;
  /** The position open in the editor, drawn as selected. */
  editingId: string | null;
  onOpen: (position: PositionRow) => void;
}) {
  const t = useT();
  const pnl = useRealtime((state) => state.pnl);
  const [places, setPlaces] = useState<Record<string, number | null>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const [scale, setScale] = useState(0);
  const closer = useCloser(accountId, t);

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
    const frame = requestAnimationFrame(place);
    chart.timeScale().subscribeVisibleLogicalRangeChange(place);
    chart.subscribeCrosshairMove(place);
    return () => {
      cancelAnimationFrame(frame);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(place);
      chart.unsubscribeCrosshairMove(place);
    };
  }, [chartRef, seriesRef, positions, revision]);

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
        const waiting = closer.closing.has(position.id);
        return (
          <div
            key={position.id}
            className={cn(
              'pointer-events-auto absolute flex items-stretch overflow-hidden rounded border bg-terminal-surface text-caption shadow',
              editingId === position.id ? 'border-terminal-accent' : 'border-terminal-border',
            )}
            style={{ top: y, right: scale + 8, transform: 'translateY(-50%)' }}
            data-testid="position-chip"
            data-position-id={position.id}
          >
            <button
              type="button"
              className="flex items-stretch"
              aria-expanded={editingId === position.id}
              aria-label={t(
                'chart.positionDetails',
                { volume: position.volume, symbol: position.symbol },
                false,
              )}
              onClick={() => onOpen(position)}
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
                  onClick={() => {
                    setAsking(null);
                    closer.close(position, null);
                  }}
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
        );
      })}
    </div>
  );
}

/**
 * Closing from the chart: one close per position on the wire, and a refusal
 * said out loud. The row disappears only when the server's answer reaches
 * the list.
 */
function useCloser(accountId: string | null, t: ReturnType<typeof useT>) {
  const close = useClosePosition(accountId);
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const run = (position: PositionRow, volume: string | null) => {
    // Synchronous: a double tap lands twice before the re-render disables it.
    if (inFlight.current.has(position.id)) return;
    inFlight.current.add(position.id);
    setClosing(new Set(inFlight.current));
    close
      .mutateAsync({ positionId: position.id, volume })
      .catch((error: unknown) => {
        playTradeSound('order_rejected', `close-failed:${position.id}:${Date.now()}`);
        useToasts.getState().push({
          id: `close-failed:${position.id}`,
          tone: 'danger',
          sticky: true,
          title: t('pos.closeFailed'),
          ...(error instanceof Error ? { body: error.message } : {}),
        });
      })
      .finally(() => {
        inFlight.current.delete(position.id);
        setClosing(new Set(inFlight.current));
      });
  };
  return { closing, close: run };
}

/**
 * A position's stop and target, in a small box at the chart's lower corner —
 * where the oldest bars are, not the newest, and away from the toasts,
 * which on a phone arrive at the top.
 *
 * Side, size and entry; a field each for SL and TP with what the position
 * would make or lose there; Save and Cancel; and closing, whole or half. The
 * fields and the chart's lines are one value: typing moves the line, dragging
 * the line fills the field. Nothing is sent until Save, which sends both in
 * one request and closes the box only when the server has answered and the
 * position list holds the new values; a refusal keeps the box open with the
 * server's reason. A value the engine would refuse is caught before sending,
 * by the engine's own rule.
 */
function LevelEditor({
  position,
  spec,
  edit,
  dirty,
  reference,
  accountId,
  currency,
  onChange,
  onDone,
}: {
  position: PositionRow;
  spec: SymbolRow;
  edit: LevelEdit;
  dirty: boolean;
  reference: string | null;
  accountId: string | null;
  currency: string;
  onChange: (edit: LevelEdit) => void;
  onDone: () => void;
}) {
  const t = useT();
  const modify = useModifyPosition(accountId);
  const closer = useCloser(accountId, t);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = editErrors(spec, position, edit, reference);
  const invalid = errors.stopLoss !== null || errors.takeProfit !== null;
  const saving = modify.isPending;
  const half = halfVolume(spec, position);
  const shape =
    edit.stopLoss.trim() !== '' && edit.takeProfit.trim() !== '' && !invalid
      ? riskReward(
          { ...position, stopLoss: edit.stopLoss, takeProfit: edit.takeProfit },
          spec,
          LevelKind.STOP_LOSS,
          edit.stopLoss,
          currency,
        )
      : null;

  const save = () => {
    if (!dirty || invalid || saving) return;
    setServerError(null);
    modify
      .mutateAsync({ positionId: position.id, ...editChanges(position, edit) })
      .then(onDone)
      .catch((error: unknown) => {
        playTradeSound('order_rejected', `edit-refused:${position.id}:${Date.now()}`);
        setServerError(error instanceof Error ? error.message : t('chart.refused'));
      });
  };

  const field = (kind: 'stopLoss' | 'takeProfit') => {
    const label = kind === 'stopLoss' ? 'SL' : 'TP';
    const text = edit[kind];
    const raw = errors[kind];
    // The editor's own two messages in the reader's language; the engine's
    // rule messages as the engine words them.
    const error =
      raw === 'Not a price.'
        ? t('chart.notPrice')
        : raw?.startsWith('Must be a multiple') === true
          ? t('chart.offGrid', { tick: spec.tickSize })
          : raw;
    const outcome =
      text.trim() === '' || raw !== null ? null : outcomeAt(position, spec, text.trim(), currency);
    const id = `edit-${kind}-${position.id}`;
    return (
      <div>
        <div className="flex items-center gap-1">
          <label htmlFor={id} className="w-7 shrink-0 text-label text-terminal-muted">
            {label}
          </label>
          <input
            id={id}
            className={cn(
              inputClass,
              'numeric min-w-0 flex-1 px-1.5 py-1 text-caption',
              error !== null && 'border-terminal-short',
            )}
            inputMode="decimal"
            autoComplete="off"
            placeholder="—"
            value={text}
            disabled={saving}
            aria-invalid={error !== null}
            onChange={(event) => {
              setServerError(null);
              onChange({ ...edit, [kind]: event.target.value });
            }}
            data-testid={`sltp-${label.toLowerCase()}`}
          />
          {text.trim() === '' ? (
            <button
              type="button"
              className="min-h-7 min-w-7 rounded border border-dashed border-terminal-border text-terminal-text"
              aria-label={t('chart.addLevel', { label })}
              disabled={saving}
              onClick={() => {
                const draft = draftLevel(
                  spec,
                  position,
                  kind === 'stopLoss' ? LevelKind.STOP_LOSS : LevelKind.TAKE_PROFIT,
                  reference,
                );
                if (draft !== null) onChange({ ...edit, [kind]: draft.price });
              }}
              data-testid={`sltp-add-${label.toLowerCase()}`}
            >
              +
            </button>
          ) : (
            <button
              type="button"
              className="min-h-7 min-w-7 rounded border border-terminal-border text-terminal-muted"
              aria-label={t('chart.removeLevel', { label })}
              disabled={saving}
              onClick={() => onChange({ ...edit, [kind]: '' })}
            >
              ×
            </button>
          )}
        </div>
        {error !== null ? (
          <p className="ms-8 mt-0.5 text-micro text-terminal-short">{error}</p>
        ) : outcome !== null ? (
          <p className={cn('numeric ms-8 mt-0.5 text-micro', toneClass[toneOf(outcome)])}>
            {signedMoney(outcome, currency)}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label={t('chart.editLevels', { symbol: position.symbol })}
      className="absolute bottom-2 start-2 z-20 w-56 rounded-md border border-terminal-border bg-terminal-surface/95 p-2 text-caption shadow-lg shadow-black/40 backdrop-blur-sm"
      data-testid="sltp-editor"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="numeric">
          <span
            className={cn(
              'font-medium',
              position.side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
            )}
          >
            {t(position.side === 'BUY' ? 'ticket.side.BUY' : 'ticket.side.SELL')} {position.volume}
          </span>
          <span className="text-terminal-muted"> @ {position.entryPrice}</span>
        </span>
        <button
          type="button"
          className="min-h-7 min-w-7 text-terminal-muted hover:text-terminal-text"
          aria-label={t('wallet.cancel')}
          onClick={onDone}
        >
          ×
        </button>
      </div>
      <div className="space-y-1.5">
        {field('stopLoss')}
        {field('takeProfit')}
      </div>
      {shape === null ? null : (
        <p className="numeric mt-1 text-micro text-terminal-muted">R:R {shape.ratio}</p>
      )}
      {serverError === null ? null : (
        <p className="mt-1 text-micro text-terminal-short" role="alert" data-testid="sltp-error">
          {serverError}
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <button
          type="button"
          className="min-h-8 rounded border border-terminal-border text-terminal-text"
          onClick={onDone}
          disabled={saving}
          data-testid="sltp-cancel"
        >
          {t('wallet.cancel')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded bg-terminal-accent font-medium text-terminal-bg disabled:opacity-40"
          onClick={save}
          disabled={!dirty || invalid || saving}
          data-testid="sltp-save"
        >
          {saving ? t('chart.saving') : t('chart.save')}
        </button>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 border-t border-terminal-border pt-1">
        {half === null ? (
          <span />
        ) : (
          <button
            type="button"
            className="min-h-8 rounded text-terminal-text disabled:opacity-40"
            disabled={closer.closing.has(position.id)}
            onClick={() => closer.close(position, half)}
            data-testid="position-chip-half"
          >
            {t('pos.closeVolume', { volume: half })}
          </button>
        )}
        <button
          type="button"
          className="min-h-8 rounded text-terminal-short disabled:opacity-40"
          disabled={closer.closing.has(position.id)}
          onClick={() => closer.close(position, null)}
          data-testid="position-chip-close"
        >
          {closer.closing.has(position.id) ? t('chart.closing') : t('pos.close')}
        </button>
      </div>
    </div>
  );
}

/** Chips closer than this are spread apart; about one chip's height. */
const CHIP_GAP_PX = 28;
