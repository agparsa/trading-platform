'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Tabs, inputClass } from '@/components/primitives';
import {
  useAdminWithdrawals,
  useClaimWithdrawal,
  useDecideWithdrawal,
  useOpenWithdrawalDestination,
  useReleaseWithdrawal,
  useSettlePayout,
  useStartPayout,
  type AdminWithdrawalRow,
} from '@/lib/admin-queries';
import { money, utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

type Tab = 'queue' | 'PAID' | 'REJECTED' | 'FAILED' | 'CANCELLED';

const STATUS_TONE: Record<string, string> = {
  REQUESTED: 'text-terminal-warning',
  UNDER_REVIEW: 'text-terminal-warning',
  APPROVED: 'text-terminal-text',
  PROCESSING: 'text-terminal-text',
  PAID: 'text-terminal-long',
  REJECTED: 'text-terminal-short',
  FAILED: 'text-terminal-short',
  CANCELLED: 'text-terminal-muted',
};

/**
 * The finance desk.
 *
 * Three capabilities meet here. `withdrawals.read_any` shows the queue;
 * `withdrawals.review` approves and rejects; `withdrawals.pay` opens the
 * destination, records that the transfer was sent, and records that it went.
 * An ADMIN sees this screen and is refused on every button, which is correct:
 * the capabilities that create money and the ones that let it out are never
 * one person's, and that is what the FINANCE role is for.
 *
 * The destination is opened on request and shown until the row closes. Every
 * opening is audited on the server; the page never caches it.
 */
export function WithdrawalsPanel() {
  const [tab, setTab] = useState<Tab>('queue');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAdminWithdrawals(tab);
  const rows = list.data?.withdrawals ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={(next) => {
            setTab(next);
            setSelected(null);
          }}
          tabs={[
            { id: 'queue', label: 'In flight' },
            { id: 'PAID', label: 'Paid' },
            { id: 'REJECTED', label: 'Rejected' },
            { id: 'FAILED', label: 'Failed' },
            { id: 'CANCELLED', label: 'Cancelled' },
          ]}
        />
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'withdrawal' : 'withdrawals'}
        </span>
      </div>

      <ErrorLine error={list.error} />

      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>{tab === 'queue' ? 'Nothing is waiting to be paid.' : 'Nothing here.'}</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Requested',
              'Who',
              { label: 'Amount', right: true },
              'To',
              'Identity',
              'Status',
              '',
            ]}
          />
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-text">{row.email}</td>
                <td className="numeric px-3 py-1.5 text-right text-terminal-text">
                  {money(row.amount, row.currency)}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">…{row.destinationHint}</td>
                <td
                  className={cn(
                    'px-3 py-1.5',
                    row.identityVerified ? 'text-terminal-long' : 'text-terminal-short',
                  )}
                >
                  {row.identityVerified ? 'verified' : 'NOT verified'}
                </td>
                <td className={cn('px-3 py-1.5', STATUS_TONE[row.status] ?? 'text-terminal-text')}>
                  {row.status}
                  {row.autoApproved ? (
                    <span className="ml-1 text-[10px] text-terminal-muted">(auto)</span>
                  ) : null}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    onClick={() => setSelected(selected === row.id ? null : row.id)}
                  >
                    {selected === row.id ? 'Close' : 'Work'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected === null ? null : (
        <WorkRow row={rows.find((one) => one.id === selected)} onDone={() => setSelected(null)} />
      )}
    </div>
  );
}

function WorkRow({ row, onDone }: { row: AdminWithdrawalRow | undefined; onDone: () => void }) {
  const claim = useClaimWithdrawal();
  const release = useReleaseWithdrawal();
  const decide = useDecideWithdrawal();
  const start = useStartPayout();
  const settle = useSettlePayout();
  const open = useOpenWithdrawalDestination();
  const [destination, setDestination] = useState<string | null>(null);
  const [reference, setReference] = useState('');

  if (row === undefined) return null;
  const busy =
    claim.isPending || release.isPending || decide.isPending || start.isPending || settle.isPending;
  const awaiting = row.status === 'REQUESTED' || row.status === 'UNDER_REVIEW';

  return (
    <div className="space-y-3 border-t border-terminal-border bg-terminal-raised/30 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
            Withdrawal {row.id.slice(0, 8)} · {row.email}
          </p>
          <p className={cn('text-sm', STATUS_TONE[row.status] ?? 'text-terminal-text')}>
            {money(row.amount, row.currency)} · {row.status}
            {row.reason === null ? '' : ` — ${row.reason}`}
          </p>
          <p className="text-[10px] text-terminal-muted">
            {row.approvedAt === null ? '' : `Approved ${utcTime(row.approvedAt)}. `}
            {row.providerReference === null ? '' : `Reference ${row.providerReference}. `}
            {!row.identityVerified ? 'This person is not currently verified.' : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {row.status === 'REQUESTED' ? (
            <Button
              variant="neutral"
              className="px-2 py-0.5"
              disabled={busy}
              onClick={() => claim.mutate({ id: row.id })}
            >
              Take this one
            </Button>
          ) : null}
          {row.status === 'UNDER_REVIEW' ? (
            <Button
              variant="ghost"
              className="px-2 py-0.5"
              disabled={busy}
              onClick={() => release.mutate({ id: row.id })}
            >
              Put back
            </Button>
          ) : null}
          {awaiting ? (
            <ReasonedAction
              label="Approve"
              title="What you checked — name, account, identity"
              minLength={8}
              busy={busy}
              onConfirm={(reason) => decide.mutate({ id: row.id, outcome: 'APPROVED', reason })}
            />
          ) : null}
          {awaiting || row.status === 'APPROVED' ? (
            <ReasonedAction
              label="Reject"
              variant="danger"
              title="Why — the person is shown this, and the money goes back"
              minLength={8}
              busy={busy}
              onConfirm={(reason) =>
                decide.mutate({ id: row.id, outcome: 'REJECTED', reason }, { onSuccess: onDone })
              }
            />
          ) : null}
        </div>
      </div>

      <ErrorLine
        error={
          claim.error ?? release.error ?? decide.error ?? start.error ?? settle.error ?? open.error
        }
      />

      {row.status === 'APPROVED' || row.status === 'PROCESSING' ? (
        <div className="space-y-2 rounded border border-terminal-border/60 bg-terminal-bg p-3">
          <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Pay it</p>
          {destination === null ? (
            <Button
              variant="neutral"
              className="px-2 py-0.5"
              disabled={open.isPending}
              onClick={() =>
                open.mutate(
                  { id: row.id },
                  { onSuccess: (result) => setDestination(result.destination) },
                )
              }
            >
              {open.isPending ? 'Opening…' : 'Show destination'}
            </Button>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded bg-terminal-raised px-3 py-2 font-mono text-[11px] text-terminal-text">
              {destination}
            </pre>
          )}

          {row.status === 'APPROVED' ? (
            <div className="flex flex-wrap items-center gap-1">
              <input
                className={cn(inputClass, 'w-64 py-1 text-xs')}
                placeholder="The transfer's reference, from the bank"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
              <Button
                variant="neutral"
                className="px-2 py-0.5"
                disabled={busy || reference.trim().length < 3}
                onClick={() => start.mutate({ id: row.id, providerReference: reference.trim() })}
              >
                Transfer sent
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <ReasonedAction
                label="It went — mark paid"
                title="Where you saw it settle"
                minLength={3}
                busy={busy}
                onConfirm={(reason) =>
                  settle.mutate({ id: row.id, outcome: 'PAID', reason }, { onSuccess: onDone })
                }
              />
              <ReasonedAction
                label="It bounced — mark failed"
                variant="danger"
                title="What the bank said; the money goes back"
                minLength={3}
                busy={busy}
                onConfirm={(reason) =>
                  settle.mutate({ id: row.id, outcome: 'FAILED', reason }, { onSuccess: onDone })
                }
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
