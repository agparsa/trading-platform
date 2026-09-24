'use client';

import { useState } from 'react';
import { Button, type ButtonGate, Tabs } from '@/components/primitives';
import {
  useAdminPaymentEvents,
  useAdminPayments,
  useSettlePayment,
  type AdminPaymentRow,
} from '@/lib/admin-queries';
import { money, utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

type Tab = 'awaiting' | 'all';

const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: 'text-terminal-long',
  FAILED: 'text-terminal-short',
  CANCELLED: 'text-terminal-muted',
  EXPIRED: 'text-terminal-muted',
  REQUIRES_ACTION: 'text-terminal-warning',
  PROCESSING: 'text-terminal-text',
};

const OUTCOME_TONE: Record<string, string> = {
  apply: 'text-terminal-long',
  ignore: 'text-terminal-muted',
  alarm: 'text-terminal-short',
};

/**
 * Money coming in, as an operator works with it.
 *
 * The default tab is the queue — payments waiting for a person — because that
 * is the only part of this screen that is *work*. Everything else is a record.
 *
 * Confirming credits a wallet, so it asks for a reason and records who gave it.
 * It cannot invent an amount: the sum is the one on the intent, which is what
 * the payer was told to send. An operator able to type a different number would
 * hold `wallet.adjust` under a narrower name, and no role holds both that and
 * the ability to start a payment.
 */
export function PaymentsPanel() {
  const [tab, setTab] = useState<Tab>('awaiting');
  const [expanded, setExpanded] = useState<string | null>(null);
  const payments = useAdminPayments(tab === 'awaiting' ? 'REQUIRES_ACTION' : 'all');
  const settle = useSettlePayment();

  const rows = payments.data?.payments ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={(next) => {
            setTab(next);
            setExpanded(null);
          }}
          tabs={[
            { id: 'awaiting', label: 'Awaiting confirmation' },
            { id: 'all', label: 'All payments' },
          ]}
        />
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'payment' : 'payments'}
        </span>
      </div>

      <ErrorLine error={payments.error} />
      <ErrorLine error={settle.error} />

      {payments.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>
          {tab === 'awaiting'
            ? 'Nothing is waiting for a person.'
            : 'Nobody has started a payment yet.'}
        </Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Started',
              'Who',
              'How',
              { label: 'Amount', right: true },
              'Status',
              'Settled',
              '',
            ]}
          />
          <tbody>
            {rows.map((row) => (
              <PaymentRows
                key={row.id}
                row={row}
                expanded={expanded === row.id}
                busy={settle.isPending}
                onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                onSettle={(outcome, reason) => settle.mutate({ id: row.id, outcome, reason })}
                settleGate={settle}
              />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function PaymentRows({
  row,
  expanded,
  busy,
  onToggle,
  onSettle,
  settleGate,
}: {
  row: AdminPaymentRow;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onSettle: (outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED', reason: string) => void;
  /** `payments.confirm`: finance's, not every administrator's. */
  settleGate: ButtonGate;
}) {
  const events = useAdminPaymentEvents(expanded ? row.id : null);
  const open = row.status === 'REQUIRES_ACTION' || row.status === 'PROCESSING';

  return (
    <>
      <tr className="border-t border-terminal-border/60 align-top">
        <td className="numeric px-3 py-1.5 text-terminal-muted">{utcTime(row.createdAt)}</td>
        <td className="px-3 py-1.5 text-terminal-text">{row.email}</td>
        <td className="px-3 py-1.5 text-terminal-muted">{row.provider}</td>
        <td className="numeric px-3 py-1.5 text-right text-terminal-text">
          {money(row.amount, row.currency)}
        </td>
        <td className={`px-3 py-1.5 ${STATUS_TONE[row.status] ?? 'text-terminal-text'}`}>
          {row.status}
          {row.failureReason === null ? null : (
            <span className="block text-[10px] text-terminal-muted">{row.failureReason}</span>
          )}
        </td>
        <td className="numeric px-3 py-1.5 text-terminal-muted">
          {row.settledAt === null ? '—' : utcTime(row.settledAt)}
        </td>
        <td className="px-3 py-1.5">
          <div className="flex flex-wrap items-center justify-end gap-1">
            {open ? (
              <>
                <ReasonedAction
                  label="Confirm"
                  title="Where you saw it — statement line, date"
                  busy={busy}
                  gate={settleGate}
                  onConfirm={(reason) => onSettle('SUCCEEDED', reason)}
                />
                <ReasonedAction
                  label="Reject"
                  variant="danger"
                  title="Why this payment did not arrive"
                  busy={busy}
                  gate={settleGate}
                  onConfirm={(reason) => onSettle('FAILED', reason)}
                />
              </>
            ) : null}
            <Button variant="ghost" className="px-2 py-0.5" onClick={onToggle}>
              {expanded ? 'Hide' : 'History'}
            </Button>
          </div>
        </td>
      </tr>

      {expanded ? (
        <tr className="border-t border-terminal-border/30 bg-terminal-raised/30">
          <td colSpan={7} className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
              Reference {row.id}
            </p>
            {events.isLoading ? (
              <Loading />
            ) : (events.data?.events ?? []).length === 0 ? (
              <p className="py-2 text-[11px] text-terminal-muted">
                Nothing has been reported about this payment.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {(events.data?.events ?? []).map((one) => (
                  <li key={one.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                    <span className="numeric text-terminal-muted">{utcTime(one.createdAt)}</span>
                    <span className={OUTCOME_TONE[one.outcome] ?? 'text-terminal-text'}>
                      {one.outcome}
                    </span>
                    <span className="text-terminal-text">{one.providerStatus}</span>
                    {one.note === null ? null : (
                      <span className="text-terminal-muted">— {one.note}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
