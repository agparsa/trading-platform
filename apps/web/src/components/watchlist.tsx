'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { price as formatPrice } from '@/lib/format';
import { useQuoteSnapshot, type SymbolRow } from '@/lib/queries';
import { useRealtime, type Quote } from '@/lib/realtime-store';
import { EmptyState } from './primitives';

/**
 * Live instrument list.
 *
 * Quotes arrive over the socket. The REST snapshot exists only so the list is
 * populated before the first tick — otherwise a trader opening the terminal on a
 * quiet market would stare at empty rows and reasonably conclude the platform
 * was broken.
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
  const quotes = useRealtime((state) => state.quotes);

  const seeded = useMemo(() => {
    const merged: Record<string, Quote> = {};
    for (const quote of snapshot.data ?? []) merged[quote.symbol] = quote;
    return { ...merged, ...quotes };
  }, [snapshot.data, quotes]);

  if (symbols.length === 0) {
    return <EmptyState>No instruments are enabled.</EmptyState>;
  }

  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-terminal-surface">
        <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
          <th className="px-2 py-1.5 font-medium">Symbol</th>
          <th className="px-2 py-1.5 text-right font-medium">Bid</th>
          <th className="px-2 py-1.5 text-right font-medium">Ask</th>
          {/* The first three columns are what a trader acts on; the spread is
              reference and yields first when the panel is narrow. */}
          <th className="hidden px-3 py-1.5 text-right font-medium xl:table-cell">Spread</th>
        </tr>
      </thead>
      <tbody>
        {symbols.map((symbol) => (
          <WatchlistRow
            key={symbol.code}
            symbol={symbol}
            quote={seeded[symbol.code]}
            selected={symbol.code === selected}
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </table>
  );
}

function WatchlistRow({
  symbol,
  quote,
  selected,
  onSelect,
}: {
  symbol: SymbolRow;
  quote: Quote | undefined;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  const direction = useTickDirection(quote?.bid);

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
          <span className="font-medium text-terminal-text">{symbol.code}</span>
          {symbol.sessionOpen ? null : (
            <span
              className="text-[9px] uppercase tracking-wider text-terminal-muted"
              title="Outside this instrument's trading session"
            >
              closed
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
