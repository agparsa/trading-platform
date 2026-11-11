'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { cn } from '@tp/ui';
import { accountView } from '@/lib/account-view';
import { price as formatPrice, signedMoney, toneClass, toneOf } from '@/lib/format';
import { markClasses, markFor } from '@/lib/instrument-marks';
import type {
  AccountSummary,
  AccountStateResponse,
  PendingOrderRow,
  PositionRow,
  SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { inlineStartVolume, stepVolume, volumeProblem } from '@/lib/ticket';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { useT } from '@/lib/use-locale';
import { AccountHeader } from './account-header';
import { ChartPanel } from './chart-panel';
import { ConnectionBadge } from './connection-badge';
import { OrderTicket } from './order-ticket';
import { PhonePositions } from './phone-positions';
import { Button, inputClass, wordInputClass } from './primitives';
import { TRADER_SECTIONS } from './shell/sections';
import { Watchlist } from './watchlist';

export type PhoneTab = 'markets' | 'chart' | 'trade' | 'positions' | 'account';

type Staged = { side: 'BUY' | 'SELL'; at: number; volume?: string } | null;

/**
 * The terminal on a phone.
 *
 * The desktop's three columns, stacked, made a phone scroll past a 200-pixel
 * header and a block of twelve figures to reach a chart the height of a
 * thumbnail. A phone shows one thing at a time, so this is five screens behind
 * a tab bar — Markets, Chart, Trade, Positions, Account — the way a trading
 * app is laid out, and the chart screen keeps the two prices and a lot size
 * under the thumb.
 *
 * Nothing here trades on its own. Sell and Buy *stage* the order exactly as
 * the watchlist's row ticket does and open the Trade screen, where the same
 * ticket as on the desktop asks "Send SELL 0.10 XAUUSD at market?" and runs
 * every check it runs anywhere else. The figures are the same queries and the
 * same socket as the desktop's: a second layout, not a second terminal.
 */
export function PhoneTerminal({
  symbols,
  activeSymbol,
  onSelectSymbol,
  resolution,
  onResolutionChange,
  positions,
  pending,
  account,
  accountId,
  currency,
  snapshot,
  preferences,
  staged,
  onStage,
  onStagedHandled,
  email,
  onSignOut,
}: {
  symbols: readonly SymbolRow[];
  activeSymbol: SymbolRow | undefined;
  onSelectSymbol: (code: string) => void;
  resolution: string;
  onResolutionChange: (resolution: string) => void;
  positions: readonly PositionRow[];
  pending: readonly PendingOrderRow[];
  account: AccountSummary | undefined;
  accountId: string | null;
  currency: string;
  snapshot: AccountStateResponse | undefined;
  preferences: TradingPreferences;
  staged: Staged;
  onStage: (staged: NonNullable<Staged>) => void;
  onStagedHandled: () => void;
  email: string;
  onSignOut: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<PhoneTab>('chart');
  const [picking, setPicking] = useState(false);
  const live = useRealtime((state) => state.account);
  const state = accountView(accountId, snapshot, live);
  const floating = state?.floatingPnl ?? null;

  const stage = (side: 'BUY' | 'SELL', volume: string) => {
    onStage({ side, at: Date.now(), volume });
    setTab('trade');
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-terminal-bg" data-testid="phone">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-terminal-border px-3">
        {/* The mark sits beside the button, not in it: an accessible name must
            begin with the text a button shows, and a glyph like "A$" inside
            it would be read as part of that text. */}
        <div className="flex min-w-0 items-center gap-1.5">
          {activeSymbol === undefined ? null : <Mark code={activeSymbol.code} />}
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex min-w-0 items-center gap-1 rounded py-1 text-sm font-medium text-terminal-text"
            aria-haspopup="dialog"
            aria-label={t('phone.pickInstrument', { code: activeSymbol?.code ?? '—' }, false)}
          >
            <span className="truncate">{activeSymbol?.code ?? '—'}</span>
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 12 12"
              className="shrink-0 text-terminal-muted"
            >
              <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn('numeric text-sm font-medium', toneClass[toneOf(floating)])}
            title={t('account.floating')}
          >
            {signedMoney(floating, currency)}
          </span>
          <ConnectionBadge />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === 'chart' ? (
          <>
            <div className="min-h-0 flex-1">
              <ChartPanel
                compact
                symbol={activeSymbol}
                resolution={resolution}
                onResolutionChange={onResolutionChange}
                positions={positions}
                pendingOrders={pending}
                accountId={accountId}
                currency={currency}
              />
            </div>
            {activeSymbol === undefined ? null : (
              <QuickTrade
                key={activeSymbol.code}
                symbol={activeSymbol}
                defaultVolume={preferences.defaultVolume}
                onStage={stage}
              />
            )}
          </>
        ) : tab === 'markets' ? (
          <div className="min-h-0 flex-1">
            <Watchlist
              symbols={symbols}
              selected={activeSymbol?.code ?? null}
              onSelect={(code) => {
                onSelectSymbol(code);
                setTab('chart');
              }}
              defaultVolume={preferences.defaultVolume}
              onTrade={(code, side, volume) => {
                onSelectSymbol(code);
                stage(side, volume ?? preferences.defaultVolume);
              }}
            />
          </div>
        ) : tab === 'trade' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <OrderTicket
              symbol={activeSymbol}
              account={account}
              accountId={accountId}
              preferences={preferences}
              shortcut={null}
              onShortcutHandled={() => undefined}
              staged={staged}
              onStagedHandled={onStagedHandled}
            />
          </div>
        ) : tab === 'positions' ? (
          <PhonePositions
            positions={positions}
            pending={pending}
            symbols={symbols}
            accountId={accountId}
            currency={currency}
            state={state}
            preferences={preferences}
          />
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
            <div className="border-b border-terminal-border bg-terminal-surface">
              <AccountHeader
                accountId={accountId}
                account={account}
                openPositions={positions.length}
                openOrders={pending.length}
              />
            </div>
            <nav aria-label={t('nav.sections')} className="px-3">
              <ul className="divide-y divide-terminal-border/60 rounded-lg border border-terminal-border">
                {TRADER_SECTIONS.filter((item) => item.href !== '/terminal').map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between px-3 py-3 text-sm text-terminal-text"
                    >
                      {item.key === undefined ? item.label : t(item.key)}
                      <span aria-hidden className="text-terminal-muted rtl:rotate-180">
                        ›
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex items-center justify-between px-3 text-caption text-terminal-muted">
              <span className="truncate">{email}</span>
              <Button variant="ghost" onClick={onSignOut}>
                {t('shell.signOut')}
              </Button>
            </div>
          </div>
        )}
      </main>

      <nav
        aria-label={t('phone.tabs')}
        className="grid shrink-0 grid-cols-5 border-t border-terminal-border bg-terminal-surface safe-bottom"
      >
        {TABS.map((one) => (
          <button
            key={one.id}
            type="button"
            onClick={() => setTab(one.id)}
            aria-current={tab === one.id ? 'page' : undefined}
            className={cn(
              'relative flex flex-col items-center gap-0.5 py-2 text-label transition-colors',
              tab === one.id ? 'text-terminal-text' : 'text-terminal-muted',
            )}
          >
            <TabIcon id={one.id} />
            {t(one.label)}
            {one.id === 'positions' && positions.length > 0 ? (
              <span className="absolute end-[22%] top-1 rounded-full bg-terminal-accent px-1 text-micro font-medium text-terminal-bg">
                <span className="numeric">{positions.length}</span>
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {picking ? (
        <InstrumentSheet
          symbols={symbols}
          onPick={(code) => {
            onSelectSymbol(code);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

const TABS = [
  { id: 'markets', label: 'phone.tab.markets' },
  { id: 'chart', label: 'phone.tab.chart' },
  { id: 'trade', label: 'phone.tab.trade' },
  { id: 'positions', label: 'phone.tab.positions' },
  { id: 'account', label: 'phone.tab.account' },
] as const satisfies ReadonlyArray<{ id: PhoneTab; label: string }>;

/**
 * The quick ticket under the chart: the bid to sell at, a lot size, the ask
 * to buy at — the arrangement every phone trading app shares, so a thumb
 * finds Buy on the right. It stages; it does not send.
 */
function QuickTrade({
  symbol,
  defaultVolume,
  onStage,
}: {
  symbol: SymbolRow;
  defaultVolume: string;
  onStage: (side: 'BUY' | 'SELL', volume: string) => void;
}) {
  const t = useT();
  const quote = useRealtime((state) => state.quotes[symbol.code]);
  const [volume, setVolume] = useState(() => inlineStartVolume(symbol, defaultVolume));
  const problem = volumeProblem(symbol, volume);
  const ready = problem === null && symbol.sessionOpen && quote !== undefined;

  return (
    <div
      className="shrink-0 border-t border-terminal-border bg-terminal-surface px-3 py-2"
      data-testid="quick-trade"
    >
      {/* Sell on the left and Buy on the right in every language: the bid and
          the ask are a price ladder, which reads left to right like the
          figures on it, and a hand reaching for Buy should not find Sell. */}
      <div dir="ltr" className="grid grid-cols-[1fr_minmax(0,1.1fr)_1fr] items-stretch gap-2">
        <SideButton
          side="SELL"
          label={t('ticket.side.SELL')}
          price={quote === undefined ? null : formatPrice(quote.bid, symbol.pricePrecision)}
          disabled={!ready}
          onClick={() => onStage('SELL', volume.trim())}
        />
        <div className="flex items-center rounded-lg bg-terminal-raised">
          <button
            type="button"
            className="px-2.5 py-2 text-terminal-text"
            onClick={() => setVolume(stepVolume(symbol, volume, -1))}
            aria-label={t('ticket.decrease')}
          >
            −
          </button>
          <label className="min-w-0 flex-1 text-center">
            <span className="sr-only">{t('ticket.volume')}</span>
            <input
              className={cn(
                inputClass,
                'border-0 bg-transparent px-0 py-0 text-center text-sm focus:border-0',
              )}
              value={volume}
              inputMode="decimal"
              aria-invalid={problem !== null}
              onChange={(event) => setVolume(event.target.value)}
            />
            <span aria-hidden className="block text-label text-terminal-muted">
              {t('pos.lots')}
            </span>
          </label>
          <button
            type="button"
            className="px-2.5 py-2 text-terminal-text"
            onClick={() => setVolume(stepVolume(symbol, volume, 1))}
            aria-label={t('ticket.increase')}
          >
            +
          </button>
        </div>
        <SideButton
          side="BUY"
          label={t('ticket.side.BUY')}
          price={quote === undefined ? null : formatPrice(quote.ask, symbol.pricePrecision)}
          disabled={!ready}
          onClick={() => onStage('BUY', volume.trim())}
        />
      </div>
      {problem !== null ? (
        <p className="mt-1 text-caption text-terminal-short">{problem}</p>
      ) : !symbol.sessionOpen ? (
        <p className="mt-1 text-caption text-terminal-muted">{t('wl.marketClosed')}</p>
      ) : null}
    </div>
  );
}

function SideButton({
  side,
  label,
  price,
  disabled,
  onClick,
}: {
  side: 'BUY' | 'SELL';
  label: string;
  price: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-lg px-2 py-1.5 text-center font-medium text-terminal-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-50',
        side === 'BUY' ? 'bg-terminal-long' : 'bg-terminal-short',
      )}
    >
      <span className="numeric block text-sm">{price ?? '—'}</span>
      <span className="block text-label uppercase tracking-wider">{label}</span>
    </button>
  );
}

/**
 * Choosing an instrument: a search and the list, over the screen. The
 * category is the server's; the price is the bid, as the chart draws it.
 */
function InstrumentSheet({
  symbols,
  onPick,
  onClose,
}: {
  symbols: readonly SymbolRow[];
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const quotes = useRealtime((state) => state.quotes);
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle === ''
      ? symbols
      : symbols.filter(
          (symbol) =>
            symbol.code.toLowerCase().includes(needle) ||
            symbol.description.toLowerCase().includes(needle),
        );
  }, [symbols, search]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 pt-8"
      role="dialog"
      aria-modal="true"
      aria-label={t('phone.selectInstrument')}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 flex-1 flex-col rounded-xl border border-terminal-border bg-terminal-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <h2 className="text-sm font-medium text-terminal-text">{t('phone.selectInstrument')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('pos.close')}
            className="px-2 text-body text-terminal-muted"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-3">
          <input
            className={wordInputClass}
            value={search}
            autoFocus
            dir="auto"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('phone.searchAnything')}
            aria-label={t('wl.searchLabel')}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {shown.length === 0 ? (
            <li className="px-2 py-4 text-center text-caption text-terminal-muted">
              {t('wl.noMatch')}
            </li>
          ) : (
            shown.map((symbol) => {
              const quote = quotes[symbol.code];
              return (
                <li key={symbol.code}>
                  <button
                    type="button"
                    onClick={() => onPick(symbol.code)}
                    className="flex w-full items-center justify-between gap-3 rounded px-2 py-2.5 text-start hover:bg-terminal-raised"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Mark code={symbol.code} />
                      <span className="min-w-0">
                        <span className="block text-sm text-terminal-text">{symbol.code}</span>
                        <span className="block truncate text-caption text-terminal-muted">
                          {symbol.category ?? symbol.description}
                        </span>
                      </span>
                    </span>
                    <span className="numeric shrink-0 text-caption text-terminal-text">
                      {quote === undefined ? '—' : formatPrice(quote.bid, symbol.pricePrecision)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

/** The instrument's mark, as the watchlist draws it, here always shown. */
function Mark({ code }: { code: string }) {
  const mark = markFor(code);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-sm text-label font-semibold leading-none ring-1 ring-inset',
        markClasses(mark.kind),
      )}
    >
      {mark.glyph}
    </span>
  );
}

/** Line icons for the tab bar, drawn in the text colour. */
function TabIcon({ id }: { id: PhoneTab }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (id) {
    case 'markets':
      return (
        <svg {...common}>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M7 14l3-3 3 2 4-5" />
        </svg>
      );
    case 'trade':
      return (
        <svg {...common}>
          <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" />
        </svg>
      );
    case 'positions':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
        </svg>
      );
  }
}
