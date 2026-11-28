'use client';

import { cn } from '@tp/ui';
import { price as formatPrice, signedChange } from '@/lib/format';
import { distanceInPoints } from '@/lib/points';
import { useMarketStats, type SymbolRow } from '@/lib/queries';
import type { Quote } from '@/lib/realtime-store';
import { useT } from '@/lib/use-locale';
import { useTickDirection } from './watchlist';

/**
 * The instrument's figures in one line over the chart: bid and ask, the spread
 * in points, the day's change and the day's range.
 *
 * Every dealing screen puts these above the chart, because they answer the
 * questions asked before any order: what does it cost to deal, how wide is it,
 * and where is it in today's range. The chart header used to show the bid
 * alone, in muted grey.
 *
 * The change and the range are the server's (`GET /market/stats`, the same
 * figures the watchlist's change column shows), not a subtraction done here,
 * so two traders see the same day. The figures yield to the timeframes as the
 * panel narrows: the range goes first, then the change, then the spread.
 */
export function InstrumentStats({
  symbol,
  quote,
}: {
  symbol: SymbolRow;
  quote: Quote | undefined;
}) {
  const t = useT();
  const stats = useMarketStats();
  const row = stats.data?.find((item) => item.symbol === symbol.code);
  const direction = useTickDirection(quote?.bid);
  const precision = symbol.pricePrecision;

  const spread = quote === undefined ? null : distanceInPoints(quote.ask, quote.bid, precision);
  const percent = signedChange(row?.changePercent ?? null);
  const changeTone =
    percent.direction === 'up'
      ? 'text-terminal-long'
      : percent.direction === 'down'
        ? 'text-terminal-short'
        : 'text-terminal-muted';
  const change = signedPrice(row?.change ?? null, precision);

  return (
    <dl
      aria-label={t('chart.statsLabel', { code: symbol.code })}
      className="flex min-w-0 items-baseline gap-3 overflow-hidden text-caption"
      data-testid="instrument-stats"
    >
      <Stat label={t('col.bid')}>
        <span
          className={cn(
            'transition-colors duration-300',
            direction === 'up'
              ? 'text-terminal-long'
              : direction === 'down'
                ? 'text-terminal-short'
                : 'text-terminal-text',
          )}
        >
          {quote === undefined ? '—' : formatPrice(quote.bid, precision)}
        </span>
      </Stat>
      <Stat label={t('col.ask')}>
        {quote === undefined ? '—' : formatPrice(quote.ask, precision)}
      </Stat>
      <Stat label={t('col.spread')} title={t('chart.spreadTitle')} className="hidden xl:flex">
        {spread === null ? '—' : `${spread} ${t('chart.pt')}`}
      </Stat>
      <Stat label={t('chart.dayChange')} title={t('wl.changeTitle')} className="hidden 2xl:flex">
        <span className={changeTone}>
          {change === null ? percent.text : `${change} (${percent.text})`}
        </span>
      </Stat>
      <Stat label={t('chart.dayHigh')} className="hidden 2xl:flex">
        {formatPrice(row?.high ?? null, precision)}
      </Stat>
      <Stat label={t('chart.dayLow')} className="hidden 2xl:flex">
        {formatPrice(row?.low ?? null, precision)}
      </Stat>
    </dl>
  );
}

function Stat({
  label,
  title,
  className,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex shrink-0 items-baseline gap-1', className)} title={title}>
      <dt className="text-label uppercase tracking-wider text-terminal-muted">{label}</dt>
      <dd className="numeric text-terminal-text">{children}</dd>
    </div>
  );
}

/** A price difference with its sign, at the instrument's precision; for the eye only. */
function signedPrice(value: string | null, precision: number): string | null {
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const text = Math.abs(numeric).toFixed(precision);
  if (Number(text) === 0) return null;
  return `${numeric > 0 ? '+' : '-'}${text}`;
}
