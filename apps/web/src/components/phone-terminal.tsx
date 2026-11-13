'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { accountView } from '@/lib/account-view';
import { price as formatPrice, signedMoney, toneClass, toneOf } from '@/lib/format';
import {
  useOpenPosition,
  type AccountSummary,
  type AccountStateResponse,
  type OrderAck,
  type PendingOrderRow,
  type PositionRow,
  type SymbolRow,
} from '@/lib/queries';
import { useToasts } from '@/lib/toasts';
import { playTradeSound } from '@/lib/trade-sounds';
import { tradingToast } from '@/lib/trading-toasts';
import { useRealtime } from '@/lib/realtime-store';
import { inlineStartVolume, stepVolume, volumeProblem } from '@/lib/ticket';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { useT } from '@/lib/use-locale';
import { useStale } from '@/lib/use-stale';
import { ChartPanel } from './chart-panel';
import { ConnectionBadge } from './connection-badge';
import { OrderTicket } from './order-ticket';
import { InstrumentIcon } from './instrument-icon';
import { PhoneAccount } from './phone-account';
import { PhonePositions } from './phone-positions';
import { inputClass, wordInputClass } from './primitives';
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
  oneClickAllowed = false,
  onPreferencesChange,
  staged,
  onStage,
  onStagedHandled,
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
  /** The firm's `quick_trading` flag: without it one-tap cannot be armed. */
  oneClickAllowed?: boolean;
  onPreferencesChange?: (patch: Partial<TradingPreferences>) => void;
  staged: Staged;
  onStage: (staged: NonNullable<Staged>) => void;
  onStagedHandled: () => void;
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
          {activeSymbol === undefined ? null : <InstrumentIcon code={activeSymbol.code} />}
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
                accountId={accountId}
                armed={oneClickAllowed && preferences.oneClick && !preferences.confirm}
                {...(oneClickAllowed && onPreferencesChange !== undefined
                  ? {
                      onArm: (on: boolean) => onPreferencesChange({ oneClick: on, confirm: !on }),
                    }
                  : {})}
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
              icons
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
          <PhoneAccount accountId={accountId} snapshot={snapshot} onSignOut={onSignOut} />
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
 * finds Buy on the right.
 *
 * By default it stages: the Trade screen asks before anything is sent. Armed
 * — the trader's own switch, and only where the firm allows quick trading —
 * one tap sends a market order. The same request as the ticket's, through
 * the same server checks (risk, margin, session); nothing is skipped but the
 * question. While one is on the wire both buttons wait, so one tap is one
 * order; the request carries its own idempotency key, so a retry of it is
 * the same order. "Filled" is said only from the server's answer.
 */
function QuickTrade({
  symbol,
  defaultVolume,
  onStage,
  accountId,
  armed,
  onArm,
}: {
  symbol: SymbolRow;
  defaultVolume: string;
  onStage: (side: 'BUY' | 'SELL', volume: string) => void;
  accountId: string | null;
  armed: boolean;
  /** Absent where the firm has switched quick trading off. */
  onArm?: (on: boolean) => void;
}) {
  const t = useT();
  const quote = useRealtime((state) => state.quotes[symbol.code]);
  const [volume, setVolume] = useState(() => inlineStartVolume(symbol, defaultVolume));
  const open = useOpenPosition(accountId);
  const problem = volumeProblem(symbol, volume);
  const stale = useStale(quote?.timestamp, quote !== undefined && symbol.sessionOpen);
  const ready = problem === null && symbol.sessionOpen && quote !== undefined && !open.isPending;

  /**
   * Set synchronously on the tap. `open.isPending` disables the buttons, but
   * only from the next render — and two taps a few milliseconds apart are
   * both delivered before it. This is what makes a double tap one order.
   */
  const inFlight = useRef(false);

  const press = (side: 'BUY' | 'SELL') => {
    const lots = volume.trim();
    if (!armed || accountId === null) {
      onStage(side, lots);
      return;
    }
    if (inFlight.current || open.isPending) return;
    inFlight.current = true;
    open
      .mutateAsync({
        accountId,
        symbol: symbol.code,
        side,
        volume: lots,
        stopLoss: null,
        takeProfit: null,
      })
      .then((ack) => announce(ack, t))
      .catch((error: unknown) => {
        playTradeSound('order_rejected', `tap-refused:${Date.now()}`);
        useToasts.getState().push({
          tone: 'danger',
          sticky: true,
          title: t('toast.rejected', { symbol: symbol.code }),
          ...(error instanceof Error ? { body: error.message } : {}),
        });
      })
      .finally(() => {
        inFlight.current = false;
      });
  };

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
          onClick={() => press('SELL')}
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
          onClick={() => press('BUY')}
        />
      </div>
      {problem !== null ? (
        <p className="mt-1 text-caption text-terminal-short">{problem}</p>
      ) : !symbol.sessionOpen ? (
        <p className="mt-1 text-caption text-terminal-muted">{t('wl.marketClosed')}</p>
      ) : stale ? (
        // The server refuses to trade on an old quote; say so before it does.
        <p className="mt-1 text-caption text-terminal-warning" data-testid="quote-stale-note">
          {t('quote.staleTitle')}
        </p>
      ) : null}
      {onArm === undefined ? null : (
        <label className="mt-1.5 flex min-h-8 items-center justify-between gap-2 text-caption">
          <span className={armed ? 'font-medium text-terminal-warning' : 'text-terminal-muted'}>
            {open.isPending
              ? t('phone.sending')
              : armed
                ? t('phone.oneTapOn')
                : t('phone.oneTapOff')}
          </span>
          <input
            type="checkbox"
            role="switch"
            className="h-5 w-9 accent-terminal-warning"
            checked={armed}
            onChange={(event) => onArm(event.target.checked)}
            aria-label={t('trade.oneClick')}
            data-testid="one-tap"
          />
        </label>
      )}
    </div>
  );
}

/**
 * Says what the server did with a one-tap order. A fill uses the same toast,
 * and the same id, as the `position.created` frame for it, so whichever
 * arrives second replaces the first instead of saying it twice.
 */
function announce(ack: OrderAck, t: ReturnType<typeof useT>): void {
  const toast =
    ack.positionId === undefined || ack.positionId === null
      ? null
      : tradingToast(
          'position.created',
          {
            positionId: ack.positionId,
            side: ack.side,
            volume: ack.volume,
            symbol: ack.symbol,
            entryPrice: ack.price,
          },
          t,
        );
  if (toast !== null) playTradeSound('trade_opened', toast.id);
  useToasts.getState().push(
    toast ?? {
      tone: 'info',
      sticky: false,
      title: t('phone.accepted', { symbol: ack.symbol, status: ack.status }),
    },
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
                      <InstrumentIcon code={symbol.code} />
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
