'use client';

import { orderLogLines } from '@/lib/order-log';
import { utcTime } from '@/lib/format';
import { useOrderLog } from '@/lib/queries';
import { ExportBar } from './export-bar';
import { Button, EmptyState, SideBadge } from './primitives';

const COLUMNS = [
  'time_utc',
  'symbol',
  'side',
  'order_type',
  'event',
  'detail',
  'reason',
  'order_id',
];

/**
 * The account's order log: everything the engine recorded about every order
 * on it, newest first — placed, checked, accepted, triggered, filled,
 * changed, cancelled, expired, refused.
 *
 * What it adds to its neighbours: Orders shows one order's trail when it is
 * opened, Finance shows what reached the balance, and Settings shows sign-ins.
 * This is the one place to read "what happened on my account, in order"
 * without opening orders one at a time. It is `GET /accounts/:id/order-events`
 * — the stored rows, the owner's view of them — and nothing here composes an
 * event the server did not write.
 *
 * Not here: an order the risk engine refused before it existed. The refusal
 * rolls the order back, so there is no order for a line to belong to; the
 * ticket shows that refusal when it happens.
 */
export function LogsPanel({ accountId }: { accountId: string | null }) {
  const log = useOrderLog(accountId);
  const lines = orderLogLines(log.data?.pages);

  if (accountId === null) return <EmptyState>No account selected.</EmptyState>;
  if (log.isError) return <EmptyState>The log could not be loaded. It will retry.</EmptyState>;
  if (log.isLoading) return <EmptyState>Loading the log…</EmptyState>;
  if (lines.length === 0) return <EmptyState>No orders on this account yet.</EmptyState>;

  return (
    <>
      <ExportBar
        label={`${lines.length} event(s)${log.hasNextPage ? ' loaded' : ''}`}
        filename="order-log"
        columns={COLUMNS}
        rows={lines.map((line) => [
          line.at,
          line.symbol,
          line.side,
          line.orderType,
          line.label,
          line.facts,
          line.reason ?? '',
          line.orderId,
        ])}
      />
      <table className="w-full border-collapse text-xs" data-testid="order-log">
        <thead className="sticky top-0 z-10 bg-terminal-surface">
          <tr className="text-left text-label uppercase tracking-wider text-terminal-muted">
            <th className="py-1.5 pl-3 pr-2 font-medium">Time (UTC)</th>
            <th className="px-2 py-1.5 font-medium">Order</th>
            <th className="px-2 py-1.5 font-medium">Event</th>
            <th className="py-1.5 pl-2 pr-3 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-terminal-border/60">
              <td className="numeric py-1.5 pl-3 pr-2 text-terminal-muted">{utcTime(line.at)}</td>
              <td className="px-2 py-1.5 text-terminal-text">
                <span className="inline-flex items-center gap-1.5">
                  {line.symbol}
                  <SideBadge side={line.side} />
                  <span className="text-terminal-muted">{line.orderType}</span>
                </span>
              </td>
              <td className="px-2 py-1.5 font-medium text-terminal-text">{line.label}</td>
              <td className="py-1.5 pl-2 pr-3 text-terminal-muted">
                {[line.facts, line.reason]
                  .filter((part) => part !== null && part !== '')
                  .join(' — ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.hasNextPage ? (
        <div className="flex justify-center border-t border-terminal-border/60 py-2">
          <Button
            variant="neutral"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
            className="px-3 py-1 text-caption"
          >
            {log.isFetchingNextPage ? 'Loading…' : 'Load older events'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
