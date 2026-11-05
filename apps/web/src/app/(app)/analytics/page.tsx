'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { PerformanceView } from '@/components/performance-view';
import { useAccounts } from '@/lib/queries';
import { useT } from '@/lib/use-locale';

/**
 * How the trading has gone: results, averages and the split by side, day and
 * month, from the account's closed trades — the server's figures, not the
 * browser's. See `@tp/trading-core`'s `performance.ts` for what each word
 * means here.
 */
export default function AnalyticsPage() {
  const accounts = useAccounts();
  const t = useT();
  const rows = accounts.data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (accountId === null && rows.length > 0) setAccountId(rows[0]?.id ?? null);
  }, [accountId, rows]);

  return (
    <AppShell title={t('nav.analytics')} description={t('perf.description')}>
      {rows.length > 1 ? (
        <div className="mb-3 flex items-center gap-2 text-caption text-terminal-muted">
          <label htmlFor="analytics-account">{t('nav.account')}</label>
          <select
            id="analytics-account"
            className="numeric rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-caption text-terminal-text"
            value={accountId ?? ''}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                #{row.number}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <PerformanceView accountId={accountId} />
    </AppShell>
  );
}
