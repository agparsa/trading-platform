'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { ContractTable } from '@/components/contract-table';
import { EmptyState, Panel } from '@/components/primitives';
import { useAccounts, useSymbols } from '@/lib/queries';

/**
 * The contract specifications: what each instrument is, and the terms this
 * firm trades it on — contract size, tick value, volume limits, margin,
 * commission, swap and trading hours.
 *
 * The margin column is measured against one account's leverage, because
 * that is what the engine charges; with more than one account the trader
 * chooses which.
 */
export default function InstrumentsPage() {
  const symbols = useSymbols();
  const accounts = useAccounts();
  const rows = accounts.data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (accountId === null && rows.length > 0) setAccountId(rows[0]?.id ?? null);
  }, [accountId, rows]);

  const account = rows.find((row) => row.id === accountId);
  const enabled = (symbols.data ?? []).filter((symbol) => symbol.enabled);

  return (
    <AppShell
      title="Instruments"
      description="Contract specifications: the terms each instrument trades on here."
    >
      {symbols.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : symbols.isError ? (
        <EmptyState>The instruments could not be loaded. It will retry.</EmptyState>
      ) : (
        <div className="space-y-3">
          {rows.length > 1 ? (
            <div className="flex items-center gap-2 text-[11px] text-terminal-muted">
              <label htmlFor="margin-account">Margin measured for</label>
              <select
                id="margin-account"
                className="numeric rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
                value={accountId ?? ''}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    #{row.number} · 1:{row.leverage}
                  </option>
                ))}
              </select>
            </div>
          ) : account === undefined ? null : (
            <p className="text-[11px] text-terminal-muted">
              Margin measured for #{account.number} at 1:{account.leverage}.
            </p>
          )}
          <Panel className="overflow-auto">
            <ContractTable symbols={enabled} leverage={account?.leverage} />
          </Panel>
        </div>
      )}
    </AppShell>
  );
}
