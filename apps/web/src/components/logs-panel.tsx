'use client';

import { orderLogLines } from '@/lib/order-log';
import { wordsFor } from '@/lib/messages';
import { ORDER_TYPE_WORDS } from '@/lib/server-words';
import { utcTime } from '@/lib/format';
import { useOrderLog } from '@/lib/queries';
import { ExportBar } from './export-bar';
import { Button, EmptyState, SideBadge } from './primitives';
import { useT } from '@/lib/use-locale';

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
  const t = useT();
  const log = useOrderLog(accountId);
  const lines = orderLogLines(log.data?.pages, t);

  if (accountId === null) return <EmptyState>{t('empty.noAccount')}</EmptyState>;
  if (log.isError) return <EmptyState>{t('logs.error')}</EmptyState>;
  if (log.isLoading) return <EmptyState>{t('logs.loading')}</EmptyState>;
  if (lines.length === 0) return <EmptyState>{t('logs.empty')}</EmptyState>;

  return (
    <>
      <ExportBar
        label={t(log.hasNextPage ? 'logs.countLoaded' : 'logs.count', { count: lines.length })}
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
          <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
            <th className="py-1.5 ps-3 pe-2 font-medium">{t('col.timeUtc')}</th>
            <th className="px-2 py-1.5 font-medium">{t('col.order')}</th>
            <th className="px-2 py-1.5 font-medium">{t('col.event')}</th>
            <th className="py-1.5 ps-2 pe-3 font-medium">{t('col.detail')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-terminal-border/60">
              <td className="py-1.5 ps-3 pe-2 text-terminal-muted">
                <span className="numeric">{utcTime(line.at)}</span>
              </td>
              <td className="px-2 py-1.5 text-terminal-text">
                <span className="inline-flex items-center gap-1.5">
                  {line.symbol}
                  <SideBadge side={line.side} />
                  <span className="text-terminal-muted">
                    {wordsFor(ORDER_TYPE_WORDS, line.orderType.toUpperCase().replace(/ /g, '_'), t)}
                  </span>
                </span>
              </td>
              <td className="px-2 py-1.5 font-medium text-terminal-text">{line.label}</td>
              <td className="py-1.5 ps-2 pe-3 text-terminal-muted">
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
            {log.isFetchingNextPage ? t('common.loading') : t('logs.older')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
