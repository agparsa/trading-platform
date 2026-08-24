'use client';

import { useMemo } from 'react';
import { cn } from '@tp/ui';
import { price as formatPrice } from '@/lib/format';
import { mergeBars } from '@/lib/bars';
import { useCandles, type CandleRow, type SymbolRow } from '@/lib/queries';
import { barKey, useRealtime } from '@/lib/realtime-store';
import { EmptyState } from './primitives';

export const RESOLUTIONS = ['1', '5', '15', '60', '240', '1D'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const RESOLUTION_LABEL: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1H',
  '240': '4H',
  '1D': '1D',
};

/**
 * Price history.
 *
 * Drawn from the server's own candles — the same rows `/market/candles` returns,
 * with the in-progress bar merged in from the `candle.update` stream. Nothing
 * here is synthesised: if the server has no bars for a window, the panel says so
 * rather than drawing a plausible-looking line.
 *
 * This is an SVG rendering of real data, not the finished charting surface.
 * TradingView Advanced Charts — indicators, drawing tools, order-from-chart —
 * is Phase 9, and needs the licensed library dropped into
 * `apps/web/public/charting_library/`.
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

  const bars = useMemo(() => mergeBars(history.data ?? [], liveBars), [history.data, liveBars]);

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

      <div className="min-h-0 flex-1">
        {symbol === undefined ? (
          <EmptyState>Select an instrument.</EmptyState>
        ) : history.isLoading ? (
          <EmptyState>Loading bars…</EmptyState>
        ) : bars.length === 0 ? (
          <EmptyState>
            No bars recorded for {symbol.code} at {RESOLUTION_LABEL[resolution]} in this window.
          </EmptyState>
        ) : (
          <Candlesticks bars={bars} precision={symbol.pricePrecision} />
        )}
      </div>

      <p className="shrink-0 border-t border-terminal-border px-3 py-1 text-[10px] text-terminal-muted">
        Server candles, built from the bid. Indicators, drawing tools and order-from-chart arrive
        with the licensed charting library in Phase 9.
      </p>
    </div>
  );
}

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 320;
const PADDING = { top: 8, right: 62, bottom: 18, left: 6 };
/** Fewer bars than this and the series would stretch into a bar chart. */
const MIN_SLOTS = 60;

/**
 * Candlesticks in plain SVG.
 *
 * Coordinates are computed with JS numbers, which is fine and deliberate: these
 * are pixel positions, not money. Every *price* rendered as text comes from the
 * server's decimal string and is formatted, never arithmetic'd.
 */
function Candlesticks({ bars, precision }: { bars: readonly CandleRow[]; precision: number }) {
  const geometry = useMemo(() => {
    const highs = bars.map((bar) => Number(bar.high));
    const lows = bars.map((bar) => Number(bar.low));
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    // A perfectly flat series would divide by zero; give it a nominal band.
    const span = max - min || Math.max(Math.abs(max) * 0.001, 0.0001);
    const pad = span * 0.08;
    const top = max + pad;
    const bottom = min - pad;

    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
    // Laid out against a minimum number of slots and filled from the right, the
    // way every chart does. A fresh instance with four bars would otherwise
    // stretch them across the whole panel and read as a market that moves in
    // enormous steps.
    const slots = Math.max(bars.length, MIN_SLOTS);
    const slot = plotWidth / slots;
    const bodyWidth = Math.max(1, Math.min(slot * 0.65, 14));
    const offset = slots - bars.length;

    const y = (value: number) => PADDING.top + ((top - value) / (top - bottom)) * plotHeight;
    const x = (index: number) => PADDING.left + slot * (offset + index + 0.5);

    return { top, bottom, slot, bodyWidth, y, x, plotHeight };
  }, [bars]);

  const gridPrices = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, index) => {
      const value = geometry.bottom + ((geometry.top - geometry.bottom) * index) / steps;
      return { value, y: geometry.y(value) };
    });
  }, [geometry]);

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      role="img"
      aria-label={`${bars.length} price bars`}
    >
      {gridPrices.map((line) => (
        <g key={line.value}>
          <line
            x1={PADDING.left}
            x2={VIEW_WIDTH - PADDING.right}
            y1={line.y}
            y2={line.y}
            stroke="var(--tp-border)"
            strokeWidth={1}
          />
          <text
            x={VIEW_WIDTH - PADDING.right + 6}
            y={line.y + 3.5}
            fill="var(--tp-text-muted)"
            fontSize={10}
            fontFamily="var(--tp-font-numeric)"
          >
            {formatPrice(String(line.value), precision)}
          </text>
        </g>
      ))}

      {bars.map((bar, index) => {
        const open = Number(bar.open);
        const close = Number(bar.close);
        const centre = geometry.x(index);
        const up = close >= open;
        const colour = up ? 'var(--tp-long)' : 'var(--tp-short)';
        const bodyTop = geometry.y(Math.max(open, close));
        const bodyBottom = geometry.y(Math.min(open, close));

        return (
          <g key={bar.time}>
            <line
              x1={centre}
              x2={centre}
              y1={geometry.y(Number(bar.high))}
              y2={geometry.y(Number(bar.low))}
              stroke={colour}
              strokeWidth={1}
            />
            <rect
              x={centre - geometry.bodyWidth / 2}
              y={bodyTop}
              width={geometry.bodyWidth}
              // A doji has zero height; give it a visible line instead.
              height={Math.max(1, bodyBottom - bodyTop)}
              fill={colour}
            />
          </g>
        );
      })}
    </svg>
  );
}
