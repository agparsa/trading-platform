'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { useSocket } from '@/lib/use-socket';
import { useRealtime } from '@/lib/realtime-store';
import {
  invalidateTradingState,
  useAccounts,
  useAccountState,
  usePendingOrders,
  usePositions,
  useSymbols,
} from '@/lib/queries';
import { ShortcutAction } from '@/lib/shortcuts';
import { useTradingPreferences } from '@/lib/use-trading-preferences';
import { useTradingShortcuts } from '@/lib/use-trading-shortcuts';
import { AccountHeader } from './account-header';
import { ChartPanel } from './chart-panel';
import { ConnectionBadge } from './connection-badge';
import { HistoryPanel, type HistoryTab } from './history-panel';
import { PendingPanel } from './pending-panel';
import { OrderTicket } from './order-ticket';
import { PositionsPanel } from './positions-panel';
import { TradingSettings } from './trading-settings';
import { SecuritySettings } from './security-settings';
import { Button, Panel, Tabs } from './primitives';
import { Watchlist } from './watchlist';

type BottomTab = 'open' | 'pending' | HistoryTab;

/**
 * The trading terminal.
 *
 * State is split four ways, deliberately:
 *
 *  - server state (positions, orders, trades, account) lives in React Query and
 *    is only ever what the API returned;
 *  - realtime state (quotes, P&L, bars) lives in the zustand store and is only
 *    ever what the socket delivered;
 *  - UI state (selected symbol, active tab) lives here;
 *  - form state lives in the ticket and the position editor.
 *
 * Nothing crosses those lines. The socket never writes a position into the
 * table, and the table never invents a price.
 */
export function Terminal() {
  const { user, accountId, signOut, accessToken } = useSession();
  const queryClient = useQueryClient();

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [resolution, setResolution] = useState('1');
  const [bottomTab, setBottomTab] = useState<BottomTab>('open');

  const symbols = useSymbols();
  const accounts = useAccounts();
  const openPositions = usePositions(accountId, false);
  const pendingOrders = usePendingOrders(accountId);
  const accountState = useAccountState(accountId);

  const gapDetected = useRealtime((state) => state.gapDetected);
  const { preferences, update: updatePreferences } = useTradingPreferences();
  /**
   * A keystroke asks the ticket to act rather than acting itself.
   *
   * The ticket already owns volume, side, protective levels and the validation
   * that decides whether an order is worth sending. Routing a shortcut around
   * it would create a second way to place an order, with a second set of rules
   * to keep in step — which is exactly how the two drift apart.
   */
  const [shortcut, setShortcut] = useState<{ action: ShortcutAction; at: number } | null>(null);
  const onShortcut = useCallback((action: ShortcutAction) => {
    /**
     * A close shortcut brings the positions up first.
     *
     * The panel that handles it is only mounted on its own tab, so without this
     * the key would do nothing at all while the trader happened to be looking at
     * pending orders — and a close shortcut that silently does nothing depending
     * on which tab is showing is worse than one that does not exist. Showing
     * them what they are about to act on is the better answer anyway.
     */
    if (action === ShortcutAction.CLOSE || action === ShortcutAction.CLOSE_ALL) {
      setBottomTab('open');
    }
    setShortcut({ action, at: Date.now() });
  }, []);
  useTradingShortcuts(preferences, onShortcut);

  const account = useMemo(
    () => (accounts.data ?? []).find((row) => row.id === accountId),
    [accounts.data, accountId],
  );
  const tradeableSymbols = useMemo(
    () => (symbols.data ?? []).filter((symbol) => symbol.enabled),
    [symbols.data],
  );
  const activeSymbol = useMemo(
    () => tradeableSymbols.find((symbol) => symbol.code === selectedSymbol),
    [tradeableSymbols, selectedSymbol],
  );

  /**
   * Pick something to look at as soon as the instrument list arrives — and pick
   * one that is actually trading.
   *
   * This used to take the first instrument in the list, which is alphabetical.
   * At a weekend that is AUDUSD, and every market except crypto is shut: the
   * trader's first sight of the platform was an empty chart, a price of "—", and
   * an order ticket refusing to send. Nothing was broken and everything looked
   * broken, for two days out of every seven.
   *
   * Falling back to the first instrument when nothing is open is deliberate. If
   * the whole market is shut there is no better choice, and showing an empty
   * selector would be worse than showing a closed instrument honestly labelled.
   */
  useEffect(() => {
    if (selectedSymbol !== null) return;
    const choice = tradeableSymbols.find((symbol) => symbol.sessionOpen) ?? tradeableSymbols[0];
    if (choice !== undefined) setSelectedSymbol(choice.code);
  }, [selectedSymbol, tradeableSymbols]);

  const resnapshot = useCallback(() => {
    if (accountId !== null) invalidateTradingState(queryClient, accountId);
  }, [accountId, queryClient]);

  useSocket(accessToken, resnapshot, selectedSymbol, resolution);

  /**
   * A sequence gap means frames were dropped, so anything derived from the
   * stream may be stale in a way the trader cannot see. Refetching everything is
   * the only honest response — guessing at what was missed would be worse than
   * the gap.
   */
  useEffect(() => {
    if (!gapDetected) return;
    resnapshot();
    useRealtime.getState().clearGap();
  }, [gapDetected, resnapshot]);

  const positions = openPositions.data ?? [];
  const pending = pendingOrders.data ?? [];
  const currency = account?.currency ?? 'USD';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-terminal-bg">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-terminal-border px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight text-terminal-text">
            Trading Platform
          </span>
          <ConnectionBadge />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* The watchlist is a desktop panel; on a narrow screen this is how a
              trader changes instrument. */}
          <select
            className="numeric rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text lg:hidden"
            value={selectedSymbol ?? ''}
            onChange={(event) => setSelectedSymbol(event.target.value)}
            aria-label="Instrument"
          >
            {tradeableSymbols.map((symbol) => (
              <option key={symbol.code} value={symbol.code}>
                {symbol.code}
              </option>
            ))}
          </select>
          <TradingSettings preferences={preferences} onChange={updatePreferences} />
          <SecuritySettings />
          <Link
            href="/status"
            className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
          >
            Build status
          </Link>
          <span className="text-[11px] text-terminal-muted">{user?.email ?? ''}</span>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <div className="shrink-0 border-b border-terminal-border bg-terminal-surface">
        <AccountHeader
          accountId={accountId}
          account={account}
          openPositions={openPositions.data?.length}
          openOrders={pendingOrders.data?.length}
        />
      </div>

      {/*
        Below `lg` the three columns become one, and one screen height cannot
        hold a chart, a table and an order ticket at a usable size. So the layout
        scrolls there and each panel keeps a workable minimum, instead of
        squeezing all three into the viewport and making every one of them
        useless. Above `lg` nothing scrolls: a trading screen that moves under
        the cursor is a screen you can misclick.

        The order is deliberately different too. On a phone the chart comes
        first, the ticket second and the watchlist last — the watchlist is how
        you browse, and browsing is not what you opened the terminal on a phone
        to do.
      */}
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 lg:grid-cols-[250px_minmax(0,1fr)_270px] lg:overflow-hidden xl:grid-cols-[310px_minmax(0,1fr)_280px]">
        <Panel title="Watchlist" className="order-3 max-h-80 lg:order-none lg:max-h-none">
          <Watchlist
            symbols={tradeableSymbols}
            selected={selectedSymbol}
            onSelect={setSelectedSymbol}
          />
        </Panel>

        <div className="order-1 flex min-h-[32rem] flex-col gap-2 lg:order-none lg:min-h-0">
          <Panel className="min-h-[240px] flex-[3]" bodyClassName="overflow-hidden">
            <ChartPanel
              symbol={activeSymbol}
              resolution={resolution}
              onResolutionChange={setResolution}
              positions={positions}
              accountId={accountId}
              currency={currency}
            />
          </Panel>

          <Panel
            className="min-h-[180px] flex-[2]"
            title="Activity"
            actions={
              <Tabs<BottomTab>
                active={bottomTab}
                onChange={setBottomTab}
                tabs={[
                  { id: 'open', label: 'Positions', count: positions.length },
                  { id: 'pending', label: 'Pending', count: pending.length },
                  { id: 'trades', label: 'Trades' },
                  { id: 'closed', label: 'Closed' },
                  { id: 'orders', label: 'Orders' },
                ]}
              />
            }
          >
            {bottomTab === 'pending' ? (
              <PendingPanel orders={pending} symbols={tradeableSymbols} accountId={accountId} />
            ) : bottomTab === 'open' ? (
              <PositionsPanel
                positions={positions}
                symbols={tradeableSymbols}
                accountId={accountId}
                currency={currency}
                snapshot={accountState.data}
                preferences={preferences}
                shortcut={shortcut}
                onShortcutHandled={() => setShortcut(null)}
              />
            ) : (
              <HistoryPanel
                tab={bottomTab}
                accountId={accountId}
                symbols={tradeableSymbols}
                currency={currency}
              />
            )}
          </Panel>
        </div>

        <Panel title="Order" className="order-2 min-h-[22rem] lg:order-none lg:min-h-0">
          <OrderTicket
            symbol={activeSymbol}
            account={account}
            accountId={accountId}
            preferences={preferences}
            shortcut={shortcut}
            onShortcutHandled={() => setShortcut(null)}
          />
        </Panel>
      </main>
    </div>
  );
}
