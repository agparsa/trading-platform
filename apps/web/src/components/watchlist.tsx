'use client';

import { marketNotice } from '../lib/market-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { percent, price as formatPrice } from '@/lib/format';
import { useMarketStats, useQuoteSnapshot, type SymbolRow } from '@/lib/queries';
import { markClasses, markFor } from '@/lib/instrument-marks';
import { useRealtime, type Quote } from '@/lib/realtime-store';
import {
  TOP_MOVERS,
  categoriesOf,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
  topMovers,
  viewFor,
} from '@/lib/watchlist-prefs';
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
 *
 * Categories and "Top movers" are views of the same rows, nothing more: the
 * groups are the platform's own (`category` on `GET /symbols`), and the
 * ranking is that same server change, so it moves once a minute rather than
 * on every tick under the trader's cursor.
 */
export function Watchlist({
  symbols,
  selected,
  onSelect,
  onTrade,
}: {
  symbols: readonly SymbolRow[];
  selected: string | null;
  onSelect: (code: string) => void;
  /**
   * Stage a market order in the ticket from this row's bid (sell) or ask
   * (buy). The watchlist never sends: the ticket asks, names the order, and
   * applies the same checks as every other order. Absent, the prices are plain.
   */
  onTrade?: (code: string, side: 'BUY' | 'SELL') => void;
}) {
  const snapshot = useQuoteSnapshot();
  const stats = useMarketStats();
  const quotes = useRealtime((state) => state.quotes);

  const [search, setSearch] = useState('');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [movers, setMovers] = useState(false);

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

  const categories = useMemo(() => categoriesOf(symbols), [symbols]);
  // A category chosen earlier that the list no longer has — the last
  // instrument in it was disabled — is no filter at all, not an empty list
  // with no visible reason.
  const activeCategory = category !== null && categories.includes(category) ? category : null;

  const view = useMemo(
    () => viewFor(symbols, favourites, search, favouritesOnly, activeCategory),
    [symbols, favourites, search, favouritesOnly, activeCategory],
  );

  const rows = useMemo(() => {
    if (!movers) return [...view.favourites, ...view.others];
    // Ranked from the platform's order, not favourites-first, so a tie keeps
    // the place it has in the full list.
    const shown = new Set([...view.favourites, ...view.others].map((item) => item.code));
    return topMovers(
      symbols.filter((item) => shown.has(item.code)),
      changes,
    );
  }, [movers, view, symbols, changes]);

  if (symbols.length === 0) {
    return <EmptyState>No instruments are enabled.</EmptyState>;
  }

  const emptyMessage = movers
    ? stats.isError
      ? 'Daily changes are unavailable right now.'
      : stats.data === undefined
        ? 'Daily changes have not loaded yet.'
        : 'Nothing here has moved since its reference price.'
    : favouritesOnly && favourites.length === 0
      ? 'No favourites yet. Use the star beside an instrument.'
      : 'Nothing matches that search.';

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
        <button
          type="button"
          onClick={() => setMovers((on) => !on)}
          aria-pressed={movers}
          title={
            movers
              ? `Showing the ${TOP_MOVERS} largest moves since each reference price`
              : 'Rank by the largest move since each reference price'
          }
          className={cn(
            'shrink-0 rounded border px-2 py-1 text-xs transition-colors',
            movers
              ? 'border-terminal-accent/60 text-terminal-accent'
              : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
          )}
        >
          Movers
        </button>
      </div>

      {categories.length > 0 && (
        <div
          role="group"
          aria-label="Instrument category"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-terminal-border px-2 py-1"
        >
          {[null, ...categories].map((name) => {
            const on = name === activeCategory;
            return (
              <button
                key={name ?? 'all'}
                type="button"
                onClick={() => setCategory(name)}
                aria-pressed={on}
                className={cn(
                  'shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors',
                  on
                    ? 'bg-terminal-raised text-terminal-text'
                    : 'text-terminal-muted hover:text-terminal-text',
                )}
              >
                {name ?? 'All'}
              </button>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" data-testid="watchlist-rows">
        {rows.length === 0 ? (
          <EmptyState>{emptyMessage}</EmptyState>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-terminal-surface">
              <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
                <th className="py-1.5 pl-2 pr-1 font-medium">Symbol</th>
                <th className="px-1 py-1.5 text-right font-medium">Bid</th>
                <th className="px-1 py-1.5 text-right font-medium">Ask</th>
                <th
                  className="py-1.5 pl-1 pr-2 text-right font-medium"
                  title="Change since the previous daily close, computed by the server"
                >
                  Chg %
                </th>
                {/* Reference, and first to yield: the ticket shows the spread too,
                    and only the widest layout has room for a fifth column. */}
                <th className="hidden px-3 py-1.5 text-right font-medium 2xl:table-cell">Spread</th>
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
                  onTrade={onTrade}
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
 * reader announcing "Gold XAUUSD" would be reading the row twice. Dropped below
 * `xl`, where the panel is too narrow for it and the four numbers at once.
 */
function InstrumentBadge({ code }: { code: string }) {
  const mark = markFor(code);
  return (
    <span
      aria-hidden
      title={mark.label}
      className={cn(
        'hidden h-4 w-6 shrink-0 items-center xl:inline-flex justify-center rounded-sm text-[10px] font-semibold leading-none ring-1 ring-inset',
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
  onTrade,
}: {
  symbol: SymbolRow;
  quote: Quote | undefined;
  stats: DailyStatsRow | undefined;
  starred: boolean;
  selected: boolean;
  onSelect: (code: string) => void;
  onStar: (code: string) => void;
  onTrade?: (code: string, side: 'BUY' | 'SELL') => void;
}) {
  // A closed market or a missing quote has no price to deal at; the cell stays
  // a price, not a button that the server would only refuse.
  const tradeable = onTrade !== undefined && symbol.sessionOpen && quote !== undefined;
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
      {/* Tight padding throughout, because every column must fit the panel:
          the change column is last, and when it was cut off the number
          "Movers" ranks by sat behind a scroll bar. A session label wraps
          under the code rather than widening the column. */}
      <td className="py-1.5 pl-2 pr-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
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
          'numeric px-1 py-1.5 text-right transition-colors duration-300',
          direction === 'up' && 'text-terminal-long',
          direction === 'down' && 'text-terminal-short',
          direction === null && 'text-terminal-text',
        )}
      >
        {tradeable ? (
          <PriceButton
            side="SELL"
            code={symbol.code}
            price={formatPrice(quote.bid, symbol.pricePrecision)}
            onTrade={onTrade}
          />
        ) : quote === undefined ? (
          '—'
        ) : (
          formatPrice(quote.bid, symbol.pricePrecision)
        )}
      </td>
      <td className="numeric px-1 py-1.5 text-right text-terminal-text">
        {tradeable ? (
          <PriceButton
            side="BUY"
            code={symbol.code}
            price={formatPrice(quote.ask, symbol.pricePrecision)}
            onTrade={onTrade}
          />
        ) : quote === undefined ? (
          '—'
        ) : (
          formatPrice(quote.ask, symbol.pricePrecision)
        )}
      </td>
      <td
        className={cn('numeric py-1.5 pl-1 pr-2 text-right', changeTone)}
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
      <td className="numeric hidden px-3 py-1.5 text-right text-terminal-muted 2xl:table-cell">
        {quote === undefined ? '—' : formatPrice(quote.spread, symbol.pricePrecision)}
      </td>
    </tr>
  );
}

/**
 * A price that stages an order: the bid sells, the ask buys — the price each
 * side would actually deal at. It looks like the price it replaces until
 * hovered or focused, so the list reads as a list, and its accessible name
 * says what pressing it does rather than reading out a number.
 */
function PriceButton({
  side,
  code,
  price,
  onTrade,
}: {
  side: 'BUY' | 'SELL';
  code: string;
  price: string;
  onTrade: (code: string, side: 'BUY' | 'SELL') => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} ${code} at ${price}`}
      title={`${side === 'BUY' ? 'Buy at the ask' : 'Sell at the bid'} — the ticket asks before sending`}
      onClick={(event) => {
        // The row selects; the price stages an order (which selects too).
        event.stopPropagation();
        onTrade(code, side);
      }}
      className={cn(
        'numeric rounded px-0.5 transition-colors',
        side === 'BUY'
          ? 'hover:bg-terminal-long/20 focus-visible:bg-terminal-long/20'
          : 'hover:bg-terminal-short/20 focus-visible:bg-terminal-short/20',
      )}
    >
      {price}
    </button>
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
