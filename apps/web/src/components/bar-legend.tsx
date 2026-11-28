'use client';

import { useEffect, useMemo, useState } from 'react';
import type { IChartApi, MouseEventParams, Time } from 'lightweight-charts';
import type { ChartBar } from '@tp/chart-core';
import { cn } from '@tp/ui';
import { price as formatPrice } from '@/lib/format';
import { useT } from '@/lib/use-locale';

/**
 * Open, high, low and close of the bar under the cursor, in the chart's corner.
 *
 * The figures a trader otherwise reads off the axis by eye, pixel by pixel.
 * With the cursor off the chart it shows the bar in progress. The values are
 * the bar's own, as the server sent them; only the change beside them is
 * worked out here, from that bar's open and close, for the eye.
 *
 * `pointer-events-none`: it sits over the plot and must not catch the drag
 * that moves a level or the press that opens a position.
 */
export function BarLegend({
  chartRef,
  bars,
  precision,
}: {
  chartRef: React.RefObject<IChartApi | null>;
  bars: readonly ChartBar[];
  precision: number;
}) {
  const t = useT();
  /** The hovered bar's time in seconds, the chart's own unit; `null` off the plot. */
  const [hovered, setHovered] = useState<number | null>(null);
  /**
   * Re-subscribed as the bars change, the way the level tags are: the chart is
   * created by the parent's effect, which runs after this one on the first
   * render, so on that render there is nothing to subscribe to yet.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const move = (param: MouseEventParams<Time>) => {
      setHovered(typeof param.time === 'number' ? param.time : null);
    };
    chart.subscribeCrosshairMove(move);
    return () => chart.unsubscribeCrosshairMove(move);
  }, [chartRef, bars]);

  const bar = useMemo(() => {
    const under =
      hovered === null ? undefined : bars.find((item) => Math.floor(item.time / 1000) === hovered);
    return under ?? bars.at(-1);
  }, [bars, hovered]);

  if (bar === undefined) return null;

  const open = Number(bar.open);
  const close = Number(bar.close);
  const up = close >= open;
  const tone = up ? 'text-terminal-long' : 'text-terminal-short';
  const difference = close - open;
  const percent = open === 0 ? null : (difference / open) * 100;
  const sign = difference > 0 ? '+' : difference < 0 ? '-' : '';

  const values: Array<[string, string]> = [
    [t('chart.open'), bar.open],
    [t('chart.high'), bar.high],
    [t('chart.low'), bar.low],
    [t('chart.close'), bar.close],
  ];

  return (
    <div
      dir="ltr"
      role="group"
      aria-label={t('chart.legendLabel')}
      className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap items-baseline gap-x-2 rounded bg-terminal-surface/70 px-1.5 py-0.5 text-label"
      data-testid="chart-legend"
    >
      {values.map(([label, value]) => (
        <span key={label} className="whitespace-nowrap">
          <span className="text-terminal-muted">{label} </span>
          <span className={cn('numeric', tone)}>{formatPrice(value, precision)}</span>
        </span>
      ))}
      <span className={cn('numeric whitespace-nowrap', tone)}>
        {sign}
        {Math.abs(difference).toFixed(precision)}
        {percent === null ? null : ` (${sign}${Math.abs(percent).toFixed(2)}%)`}
      </span>
    </div>
  );
}
