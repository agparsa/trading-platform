'use client';

import { marketNotice } from '../lib/market-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { percent, price as formatPrice } from '@/lib/format';
import { useMarketStats, useQuoteSnapshot, type SymbolRow } from '@/lib/queries';
import { markClasses, markFor } from '@/lib/instrument-marks';
import { useRealtime, type Quote } from '@/lib/realtime-store';
import { loadFavourites, saveFavourites, toggleFavourite, viewFor } from '@/lib/watchlist-prefs';
import { EmptyState, inputClass } from './primitives';

/**
 * Live instrument list.
 *
 * Quotes arrive over the socket. The REST snapshot exists only so the list is
 * populated before the first tick — otherwise a trader opening the terminal on a
 * quiet market would stare at empty rows and reasonably conclude the platform
 * was broken.
 *
 * The change column comes from the server too, from `GET /market/stats`, and
 * that is deliberate. A browser subtracting the price it remembers from the
 * price it has produces a number that depends on when it connected: two traders
 * would see different changes for the same instrument at the same moment, and
 * neither could say what theirs was measured against.
 */
export function Watchlist({
  symbols,
  selected,
  onSelect,
}: {
  symbols: readonly SymbolRow[];
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  const snapshot = useQuoteSnapshot();
  const stats = useMarketStats();
  const quotes = useRealtime((state) => state.quotes);

  const [search, setSearch] = useState('');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [favourites, setFavourites] = useState<string[]>([]);

  // Read once on mount, not during render: the server has no `window`, and a
  // value read during render would differ between the server pass and the
  // first client pass.
  useEffect(() => {
    setFavourites(loadFavourites(typeof window === 'undefined' ? undefined : window.localStorage));
  }, []);

  const star = useCallback((code: string) => {
    setFavourites((current) => {
      const next = toggleFavourite(current, code);
      saveFavourites(typeof window === 'undefined' ? undefined : window.localStorage, next);
      return next;
    });
  }, []);

  const seeded = useMemo(() => {
    const merged: Record<string, Quote> = {};
    for (const quote of snapshot.data ?? []) merged[quote.symbol] = quote;
    return { ...merged, ...quotes };
  }, [snapshot.data, quotes]);

  const changes = useMemo(
    () => Object.fromEntries((stats.data ?? []).map((row) => [row.symbol, row])),
    [stats.data],
  );

  const view = useMemo(
    () => viewFor(symbols, favourites, search, favouritesOnly),
    [symbols, favourites, search, favouritesOnly],
  );

  if (symbols.length === 0) {
    return <EmptyState>No instruments are enabled.</EmptyState>;
  }

  const rows = [...view.favourites, ...view.others];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-terminal-border px-2 py-1.5">
        <input
          className={cn(inputClass, 'py-1 text-xs')}
          placeholder="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search instruments"
        />
        <button
          type="button"
          onClick={() => setFavouritesOnly((on) => !on)}
          aria-pressed={favouritesOnly}
          title={favouritesOnly ? 'Showing favourites only' : 'Show favourites only'}
          className={cn(
            'shrink-0 rounded border px-2 py-1 text-xs transition-colors',
            favouritesOnly
              ? 'border-terminal-warning/60 text-terminal-warning'
              : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
          )}
        >
          ★
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState>
            {favouritesOnly && favourites.length === 0
              ? 'No favourites yet. Use the star beside an instrument.'
              : 'Nothing matches that search.'}
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-terminal-surface">
              <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
                <th className="px-2 py-1.5 font-medium">Symbol</th>
                <th className="px-2 py-1.5 text-right font-medium">Bid</th>
                <th className="px-2 py-1.5 text-right font-medium">Ask</th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title="Change since the previous daily close, computed by the server"
                >
                  Chg %
                </th>
                {/* Reference, and first to yield when the panel is narrow. */}
                <th className="hidden px-3 py-1.5 text-right font-medium xl:table-cell">Spread</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((symbol) => (
                <WatchlistRow
                  key={symbol.code}
                  symbol={symbol}
                  quote={seeded[symbol.code]}
                  stats={changes[symbol.code]}
                  starred={favourites.includes(symbol.code)}
                  selected={symbol.code === selected}
                  onSelect={onSelect}
                  onStar={star}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface DailyStatsRow {
  symbol: string;
  change: string | null;
  changePercent: string | null;
  reference: string | null;
  referenceKind: 'PREVIOUS_CLOSE' | 'SESSION_OPEN' | 'NONE';
  high: string | null;
  low: string | null;
}

/**
 * The instrument's mark.
 *
 * Eight six-letter codes in one weight is a wall of text — XAUUSD, XAGUSD and
 * AUDUSD are the same shape to an eye that is scanning rather than reading. The
 * badge is what the eye lands on; the code beside it is what confirms.
 *
 * `aria-hidden`, because the code is right there in the same cell and a screen
 * reader announcing "Gold XAUUSD" would be reading the row twice.
 */
function InstrumentBadge({ code }: { code: string }) {
  const mark = markFor(code);
  return (
    <span
      aria-hidden
      title={mark.label}
      className={cn(
        'inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold leading-none ring-1 ring-inset',
        markClasses(mark.kind),
      )}
    >
      {mark.glyph}
    </span>
  );
}

function WatchlistRow({
  symbol,
  quote,
  stats,
  starred,
  selected,
  onSelect,
  onStar,
}: {
  symbol: SymbolRow;
  quote: Quote | undefined;
  stats: DailyStatsRow | undefined;
  starred: boolean;
  selected: boolean;
  onSelect: (code: string) => void;
  onStar: (code: string) => void;
}) {
  const direction = useTickDirection(quote?.bid);
  const changePercent = stats?.changePercent ?? null;
  const changeTone =
    changePercent === null || Number(changePercent) === 0
      ? 'text-terminal-muted'
      : Number(changePercent) > 0
        ? 'text-terminal-long'
        : 'text-terminal-short';

  return (
    <tr
      onClick={() => onSelect(symbol.code)}
      className={cn(
        'cursor-pointer border-t border-terminal-border/60 transition-colors',
        selected ? 'bg-terminal-raised' : 'hover:bg-terminal-raised/50',
      )}
    >
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              // The row selects an instrument; the star does not.
              event.stopPropagation();
              onStar(symbol.code);
            }}
            aria-pressed={starred}
            aria-label={starred ? `Unstar ${symbol.code}` : `Star ${symbol.code}`}
            /**
             * The resting star is `muted`, not `border`.
             *
             * It was `text-terminal-border` — #232a35 on a #12161d row, which
             * is **1.26:1**. The intent was "subtle until hovered" and the
             * effect was invisible: the only way to favourite an instrument
             * was a control most people cannot see is there. axe never said
             * so, because the row background is semi-transparent and it files
             * those as undetermined rather than failing them.
             *
             * `muted` is the token this UI already uses for secondary text, so
             * the star stays quiet against the instrument code beside it while
             * clearing 4.5:1. The three states remain distinct: quiet, brighter
             * on hover, warning-coloured when set.
             */
            className={cn(
              'text-[11px] leading-none transition-colors',
              starred ? 'text-terminal-warning' : 'text-terminal-muted hover:text-terminal-text',
            )}
          >
            ★
          </button>
          <InstrumentBadge code={symbol.code} />
          <span className="font-medium text-terminal-text">{symbol.code}</span>
          {/* One word in a column with no room for more; the title carries the
              reason and, where the platform knows it, the opening time. */}
          {symbol.sessionOpen ? null : (
            <span
              className="rounded bg-terminal-raised px-1 text-[9px] uppercase tracking-wider text-terminal-muted"
              title={
                symbol.market === undefined
                  ? "Outside this instrument's trading session"
                  : (marketNotice(symbol.market, symbol.code).detail ??
                    "Outside this instrument's trading session")
              }
            >
              {symbol.market === undefined
                ? 'closed'
                : marketNotice(symbol.market, symbol.code).label}
            </span>
          )}
        </div>
      </td>
      <td
        className={cn(
          'numeric px-2 py-1.5 text-right transition-colors duration-300',
          direction === 'up' && 'text-terminal-long',
          direction === 'down' && 'text-terminal-short',
          direction === null && 'text-terminal-text',
        )}
      >
        {quote === undefined ? '—' : formatPrice(quote.bid, symbol.pricePrecision)}
      </td>
      <td className="numeric px-2 py-1.5 text-right text-terminal-text">
        {quote === undefined ? '—' : formatPrice(quote.ask, symbol.pricePrecision)}
      </td>
      <td
        className={cn('numeric px-2 py-1.5 text-right', changeTone)}
        title={
          stats === undefined || stats.reference === null
            ? 'No reference price yet for this instrument'
            : `${stats.change ?? '—'} from ${
                stats.referenceKind === 'PREVIOUS_CLOSE'
                  ? 'the previous daily close'
                  : "today's open"
              } of ${stats.reference}`
        }
      >
        {/* An em dash, never a zero. "No reference yet" and "unchanged" are
            different claims and only one of them is ever true here. */}
        {changePercent === null
          ? '—'
          : `${Number(changePercent) > 0 ? '+' : ''}${percent(changePercent, 2)}`}
      </td>
      <td className="numeric hidden px-3 py-1.5 text-right text-terminal-muted xl:table-cell">
        {quote === undefined ? '—' : formatPrice(quote.spread, symbol.pricePrecision)}
      </td>
    </tr>
  );
}

/**
 * Which way the last tick went, for a brief moment.
 *
 * Direction is derived from two consecutive server prices, so it says nothing
 * the server did not. It clears itself: a stale green row would suggest the
 * market is still moving up when it has stopped.
 */
function useTickDirection(value: string | undefined): 'up' | 'down' | null {
  const previous = useRef<string | undefined>(undefined);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (value === undefined) return;
    const before = previous.current;
    previous.current = value;
    if (before === undefined || before === value) return;

    setDirection(Number(value) > Number(before) ? 'up' : 'down');
    const timer = setTimeout(() => setDirection(null), 400);
    return () => clearTimeout(timer);
  }, [value]);

  return direction;
}
