'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { HistoryPanel, type HistoryTab } from '@/components/history-panel';
import { EmptyState, Panel, Tabs } from '@/components/primitives';
import { useAccounts, useSymbols } from '@/lib/queries';

const TABS: readonly { id: HistoryTab; label: string }[] = [
  { id: 'trades', label: 'Trades' },
  { id: 'closed', label: 'Closed positions' },
  { id: 'orders', label: 'Orders' },
];

/**
 * Completed activity, with room to read it.
 *
 * The same component the terminal puts in its bottom strip. There it shares a
 * screen with the chart and the book and gets a few rows; here it gets the page,
 * which is what somebody reconciling a statement actually needs. One
 * implementation, because two would eventually disagree about what a trade is.
 */
export default function HistoryPage() {
  const accounts = useAccounts();
  const symbols = useSymbols();
  const rows = accounts.data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);
  const [tab, setTab] = useState<HistoryTab>('trades');

  useEffect(() => {
    if (accountId === null && rows.length > 0) setAccountId(rows[0]?.id ?? null);
  }, [accountId, rows]);

  const account = rows.find((row) => row.id === accountId);

  return (
    <AppShell
      title="History"
      description="Trades, closed positions, and every order — including the refused ones."
    >
      {accounts.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No accounts on this login.</EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs<HistoryTab> active={tab} onChange={setTab} tabs={TABS} />
            {rows.length > 1 ? (
              <select
                className="numeric rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
                value={accountId ?? ''}
                onChange={(event) => setAccountId(event.target.value)}
                aria-label="Account"
              >
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    #{row.number}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <Panel className="min-h-[24rem] overflow-auto">
            <HistoryPanel
              tab={tab}
              accountId={accountId}
              symbols={symbols.data ?? []}
              currency={account?.currency ?? 'USD'}
            />
          </Panel>
        </div>
      )}
    </AppShell>
  );
}
