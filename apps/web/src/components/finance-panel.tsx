'use client';

import { cn } from '@tp/ui';
import { ledgerEntries, ledgerLabel } from '@/lib/ledger';
import { money, signedMoney, toneClass, toneOf, utcTime } from '@/lib/format';
import { useLedger } from '@/lib/queries';
import { ExportBar } from './export-bar';
import { Button, EmptyState } from './primitives';

const COLUMNS = ['time_utc', 'type', 'description', 'amount', 'balance_after', 'currency'];

/**
 * The account's balance history: every movement of its balance, newest first,
 * with the balance each one left.
 *
 * It is the ledger itself — `GET /accounts/:id/ledger`, append-only, the same
 * rows reconciliation replays — not a summary assembled in the browser. A
 * trader asking "why is my balance this" reads the answer line by line, and
 * the top row's balance is the balance the account shows.
 *
 * Older entries load on request. Every page is the server's; nothing here
 * adds, nets or rounds before display, and the export writes the loaded rows
 * with the server's own decimal strings.
 */
export function FinancePanel({ accountId }: { accountId: string | null }) {
  const ledger = useLedger(accountId);
  const rows = ledgerEntries(ledger.data?.pages);

  if (accountId === null) return <EmptyState>No account selected.</EmptyState>;
  if (ledger.isError) {
    return <EmptyState>The balance history could not be loaded. It will retry.</EmptyState>;
  }
  if (ledger.isLoading) return <EmptyState>Loading the balance history…</EmptyState>;
  if (rows.length === 0) return <EmptyState>No balance movements on this account yet.</EmptyState>;

  return (
    <>
      <ExportBar
        label={`${rows.length} movement(s)${ledger.hasNextPage ? ' loaded' : ''}`}
        filename="balance-history"
        columns={COLUMNS}
        rows={rows.map((row) => [
          row.createdAt,
          row.type,
          row.description ?? '',
          row.amount,
          row.balanceAfter,
          row.currency,
        ])}
      />
      <table className="w-full border-collapse text-xs" data-testid="balance-history">
        <thead className="sticky top-0 z-10 bg-terminal-surface">
          <tr className="text-left text-label uppercase tracking-wider text-terminal-muted">
            <th className="py-1.5 pl-3 pr-2 font-medium">Time (UTC)</th>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">Detail</th>
            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
            <th className="py-1.5 pl-2 pr-3 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-terminal-border/60">
              <td className="numeric py-1.5 pl-3 pr-2 text-terminal-muted">
                {utcTime(row.createdAt)}
              </td>
              <td className="px-2 py-1.5 text-terminal-text" title={row.type}>
                {ledgerLabel(row.type)}
              </td>
              <td className="max-w-[16rem] truncate px-2 py-1.5 text-terminal-muted">
                {row.description ?? '—'}
              </td>
              <td
                className={cn('numeric px-2 py-1.5 text-right', toneClass[toneOf(row.amount)])}
                title={row.amount}
              >
                {signedMoney(row.amount, row.currency)}
              </td>
              <td
                className="numeric py-1.5 pl-2 pr-3 text-right text-terminal-text"
                title={row.balanceAfter}
              >
                {money(row.balanceAfter, row.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ledger.hasNextPage ? (
        <div className="flex justify-center border-t border-terminal-border/60 py-2">
          <Button
            variant="neutral"
            disabled={ledger.isFetchingNextPage}
            onClick={() => void ledger.fetchNextPage()}
            className="px-3 py-1 text-caption"
          >
            {ledger.isFetchingNextPage ? 'Loading…' : 'Load older movements'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
