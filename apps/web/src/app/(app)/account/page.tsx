'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { AccountHeader } from '@/components/account-header';
import { FinancePanel } from '@/components/finance-panel';
import { EmptyState, Panel } from '@/components/primitives';
import { money, utcTime } from '@/lib/format';
import { useAccounts, useOrders, usePositions } from '@/lib/queries';

/**
 * One account, in full, at an address.
 *
 * The terminal shows the same strip in its header, and it is the same component
 * — a second implementation would be a second place for equity to be wrong.
 * What this page adds is everything the strip has no room for: which accounts
 * exist, when each was opened, and the terms it trades on.
 *
 * And the balance history: the account's ledger, the same component as the
 * terminal's Finance tab. The wallet page lists the wallet's own movements;
 * this lists the account's, which include every fill, commission and swap.
 */
export default function AccountPage() {
  const accounts = useAccounts();
  const rows = accounts.data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (accountId === null && rows.length > 0) setAccountId(rows[0]?.id ?? null);
  }, [accountId, rows]);

  const account = rows.find((row) => row.id === accountId);
  const openPositions = usePositions(accountId, false);
  const openOrders = useOrders(accountId);

  return (
    <AppShell title="Account" description="Balances, margin, and the terms this account trades on.">
      {accounts.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No accounts on this login.</EmptyState>
      ) : (
        <div className="space-y-4">
          {rows.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setAccountId(row.id)}
                  aria-pressed={row.id === accountId}
                  className={
                    row.id === accountId
                      ? 'rounded bg-terminal-raised px-2 py-1 text-[11px] text-terminal-text'
                      : 'rounded px-2 py-1 text-[11px] text-terminal-muted hover:text-terminal-text'
                  }
                >
                  #{row.number}
                </button>
              ))}
            </div>
          ) : null}

          <Panel>
            <AccountHeader
              accountId={accountId}
              account={account}
              openPositions={openPositions.data?.length}
              openOrders={openOrders.data?.length}
            />
          </Panel>

          {account === undefined ? null : (
            <Panel className="p-4">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Detail label="Number" value={`#${account.number}`} />
                <Detail label="Type" value={account.type} />
                <Detail label="Status" value={account.status} />
                <Detail label="Currency" value={account.currency} />
                <Detail label="Leverage" value={`1:${String(account.leverage)}`} />
                <Detail label="Balance" value={money(account.balance, account.currency)} />
                <Detail label="Opened" value={utcTime(account.createdAt)} />
              </dl>
            </Panel>
          )}

          {account === undefined ? null : (
            <Panel title="Balance history" className="max-h-[32rem]">
              <FinancePanel accountId={account.id} />
            </Panel>
          )}
        </div>
      )}
    </AppShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</dt>
      <dd className="numeric mt-0.5 truncate text-sm text-terminal-text">{value}</dd>
    </div>
  );
}
