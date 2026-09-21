'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { inputClass, Stat } from '@/components/primitives';
import {
  usePushDeliveries,
  usePushDeliverySummary,
  type PushDeliveryRow,
  type PushDeliveryStatus,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

type StatusFilter = '' | PushDeliveryStatus;

/**
 * What the platform tried to tell people, and whether it got through.
 *
 * The worker has written one `push_deliveries` row per notification per
 * device since the push phase, and `docs/notifications.md` has said since
 * then that "the admin view says sent rather than delivered". This is that
 * view, arriving late. Nothing here can be changed: a delivery record is what
 * happened. What an operator does about a dead token is on the person's
 * devices, under People.
 *
 * "Sent" means the provider accepted the message. No provider can say whether
 * the phone showed it, so the word is not "delivered" anywhere on this screen.
 */
export function NotificationsPanel() {
  const [status, setStatus] = useState<StatusFilter>('');
  const [kind, setKind] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const summary = usePushDeliverySummary();
  const list = usePushDeliveries({ status, kind: kind.trim(), errorCode: errorCode.trim() });
  const rows = list.data?.deliveries ?? [];
  const figures = summary.data;

  return (
    <div className="flex flex-col" data-testid="push-deliveries">
      {figures === undefined ? null : (
        <section className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-terminal-border px-3 py-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Attempted, last day" value={String(figures.total)} />
          <Stat
            label="Sent"
            value={String(figures.counts.SENT)}
            title="Accepted by the provider — not the same as shown on the phone"
          />
          <Stat
            label="Skipped"
            value={String(figures.counts.SKIPPED)}
            title="The person's preferences excluded the device, or push is not configured"
          />
          <Stat
            label="Failed"
            value={String(figures.counts.FAILED)}
            tone={figures.counts.FAILED > 0 ? 'text-terminal-warning' : undefined}
            title="The provider refused; the reason may pass"
          />
          <Stat
            label="Dropped"
            value={String(figures.counts.DROPPED)}
            tone={figures.counts.DROPPED > 0 ? 'text-terminal-short' : undefined}
            title="The provider says the token is dead; the device was marked"
          />
          <Stat
            label="By platform"
            value={
              figures.platforms.length === 0
                ? '—'
                : figures.platforms
                    .map((one) => `${one.platform.toLowerCase()} ${one.sent}/${one.attempted}`)
                    .join(' · ')
            }
            title="sent / attempted"
          />
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <select
          aria-label="Outcome"
          className={cn(inputClass, 'w-auto py-1 text-xs')}
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
        >
          <option value="">Any outcome</option>
          <option value="SENT">Sent</option>
          <option value="SKIPPED">Skipped</option>
          <option value="FAILED">Failed</option>
          <option value="DROPPED">Dropped</option>
          <option value="PENDING">Pending</option>
        </select>
        <input
          aria-label="Notification kind"
          className={cn(inputClass, 'max-w-xs py-1 text-xs')}
          value={kind}
          placeholder="Kind prefix, e.g. order."
          onChange={(event) => setKind(event.target.value)}
        />
        <select
          aria-label="Error code"
          className={cn(inputClass, 'w-auto py-1 text-xs')}
          value={errorCode}
          onChange={(event) => setErrorCode(event.target.value)}
        >
          <option value="">Any error</option>
          {(figures?.errors ?? []).map((error) => (
            <option key={error.code} value={error.code}>
              {error.code} ({error.count})
            </option>
          ))}
        </select>
        <span className="ml-auto text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'delivery' : 'deliveries'}
        </span>
      </div>
      <ErrorLine error={summary.error} />
      <ErrorLine error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nothing recorded for this filter.</Loading>
      ) : (
        <Table>
          <Head
            columns={['When', 'Outcome', 'Notice', 'Person', 'Device', 'Tries', 'Provider said']}
          />
          <tbody>
            {rows.map((row: PushDeliveryRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5">
                  <OutcomePill status={row.status} />
                </td>
                <td className="px-3 py-1.5 text-terminal-text">
                  <div>{row.notification.title}</div>
                  <div className="font-mono text-[10px] text-terminal-muted">
                    {row.notification.kind}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-terminal-text">{row.notification.userEmail}</td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  <div>
                    {row.device.platform.toLowerCase()}
                    {row.device.model === null ? '' : ` · ${row.device.model}`}
                    {row.device.isActive ? '' : ' · inactive'}
                  </div>
                  <div className="font-mono">{row.device.tokenFingerprint ?? 'no token'}</div>
                </td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{row.attempts}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.errorCode ??
                    (row.status === 'SENT' ? (row.providerMessageId ?? 'accepted') : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function OutcomePill({ status }: { status: PushDeliveryStatus }) {
  const tone =
    status === 'SENT'
      ? 'bg-terminal-long/15 text-terminal-long'
      : status === 'DROPPED' || status === 'FAILED'
        ? 'bg-terminal-short/15 text-terminal-short'
        : 'bg-terminal-raised text-terminal-muted';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>{status}</span>
  );
}
