'use client';

import { Fragment, useState } from 'react';
import { toneClass, toneOf } from '@/lib/format';
import { marketNotice } from '@/lib/market-state';
import { marginTerms, plain, sessionLines, tickValuePerLot } from '@/lib/contract-spec';
import { useSymbolDetail, type SymbolRow } from '@/lib/queries';
import { EmptyState } from './primitives';

/**
 * Every instrument this firm offers, on the terms it offers it.
 *
 * The terms are `GET /symbols` — the firm's own where it has set them, the
 * platform's where it has not — which is what the engine prices, margins and
 * charges with. Before this screen a trader could only learn an instrument's
 * commission or swap by trading it and reading the ledger.
 *
 * Margin is shown twice when the account's leverage binds: the instrument's
 * rate, and the rate this account is actually charged, which is the larger of
 * that and one over the leverage.
 */
export function ContractTable({
  symbols,
  leverage,
}: {
  symbols: readonly SymbolRow[];
  /** The selected account's leverage; absent, only the instrument's rate is shown. */
  leverage: number | undefined;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (symbols.length === 0) return <EmptyState>No instruments are enabled.</EmptyState>;

  return (
    <table className="w-full border-collapse text-xs" data-testid="contract-table">
      <thead className="sticky top-0 z-10 bg-terminal-surface">
        <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
          <th className="py-1.5 pl-3 pr-2 font-medium">Instrument</th>
          <th className="px-2 py-1.5 text-right font-medium">Contract</th>
          <th
            className="px-2 py-1.5 text-right font-medium"
            title="Tick size, and what one tick is worth on one lot"
          >
            Tick
          </th>
          <th className="px-2 py-1.5 text-right font-medium">Volume</th>
          <th className="px-2 py-1.5 text-right font-medium">Margin</th>
          <th
            className="px-2 py-1.5 text-right font-medium"
            title="Per lot, charged when a position opens and again when it closes"
          >
            Commission
          </th>
          <th className="px-2 py-1.5 text-right font-medium" title="Per lot, per night held">
            Swap long / short
          </th>
          <th className="py-1.5 pl-2 pr-3 text-right font-medium">Hours</th>
        </tr>
      </thead>
      <tbody>
        {symbols.map((symbol) => {
          const margin = marginTerms(symbol, leverage);
          const expanded = open === symbol.code;
          return (
            <Fragment key={symbol.code}>
              <tr className="border-t border-terminal-border/60 align-top">
                <td className="py-1.5 pl-3 pr-2">
                  <div className="font-medium text-terminal-text">{symbol.code}</div>
                  <div className="text-[11px] text-terminal-muted">
                    {symbol.description}
                    {symbol.category ? ` · ${symbol.category}` : ''}
                  </div>
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {plain(symbol.contractSize)}
                  <div className="text-[11px] text-terminal-muted">
                    quoted in {symbol.quoteCurrency}
                  </div>
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {plain(symbol.tickSize)}
                  <div className="text-[11px] text-terminal-muted">
                    {tickValuePerLot(symbol)} {symbol.quoteCurrency} a lot
                  </div>
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {plain(symbol.minVolume)} – {plain(symbol.maxVolume)}
                  <div className="text-[11px] text-terminal-muted">
                    step {plain(symbol.volumeStep)}
                  </div>
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {margin.charged ?? margin.instrument}
                  {margin.leverageBinds ? (
                    <div className="text-[11px] text-terminal-muted">
                      instrument {margin.instrument}; your leverage sets it
                    </div>
                  ) : null}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {plain(symbol.commissionPerLot)} {symbol.quoteCurrency}
                </td>
                <td className="numeric px-2 py-1.5 text-right">
                  <span className={toneClass[toneOf(symbol.swapLongPerLot)]}>
                    {plain(symbol.swapLongPerLot)}
                  </span>
                  <span className="text-terminal-muted"> / </span>
                  <span className={toneClass[toneOf(symbol.swapShortPerLot)]}>
                    {plain(symbol.swapShortPerLot)}
                  </span>
                </td>
                <td className="py-1.5 pl-2 pr-3 text-right">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={expanded ? `hours-${symbol.code}` : undefined}
                    aria-label={`${expanded ? 'Hide hours' : 'Hours'} for ${symbol.code}`}
                    onClick={() => setOpen(expanded ? null : symbol.code)}
                    className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-text hover:bg-terminal-raised"
                  >
                    {expanded ? 'Hide' : 'Hours'}
                  </button>
                  <div className="mt-0.5 text-[11px] text-terminal-muted">
                    {symbol.market === undefined
                      ? symbol.sessionOpen
                        ? 'Open'
                        : 'Closed'
                      : marketNotice(symbol.market, symbol.code).label}
                  </div>
                </td>
              </tr>
              {expanded ? <HoursRow code={symbol.code} /> : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The week's hours, asked for only when somebody opens them: the list
 * endpoint leaves sessions out, and most visitors do not need eight.
 */
function HoursRow({ code }: { code: string }) {
  const detail = useSymbolDetail(code);
  return (
    <tr id={`hours-${code}`} className="bg-terminal-raised/40">
      <td colSpan={8} className="px-3 py-2 text-[11px]">
        {detail.isError ? (
          <span className="text-terminal-muted">The trading hours could not be loaded.</span>
        ) : detail.data === undefined ? (
          <span className="text-terminal-muted">Loading the trading hours…</span>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-terminal-muted">
              Trading hours ({detail.data.session.timezone}):
            </span>
            {sessionLines(detail.data.session).map((line) => (
              <span key={line} className="numeric text-terminal-text">
                {line}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
