'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AccountRow } from '@/components/admin/accounts-panel';
import { ErrorLine, Head, Loading, Table } from '@/components/admin/shared';
import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass, wordInputClass } from '@/components/primitives';
import {
  useAdminAccount,
  useAssignFeeSchedule,
  useFeeSchedules,
  useSetAccountStatus,
} from '@/lib/admin-queries';

/**
 * One account, at an address.
 *
 * The row is the same component the list renders, so the status control and the
 * adjustment form here are literally the same code — a second copy of the form
 * that credits a ledger is not a thing to have. What this page adds is a link to
 * the owner, which is the question an operator asks next about half the time.
 */
export default function Page() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;
  const account = useAdminAccount(id);
  const setStatus = useSetAccountStatus();

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border px-3 py-1.5">
        <Link
          href="/admin/accounts"
          className="text-caption text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ← All accounts
        </Link>
        {account.data === undefined ? null : (
          <Link
            href={`/admin/people/${account.data.userId}`}
            className="text-caption text-terminal-muted transition-colors hover:text-terminal-text"
          >
            Owner: {account.data.email} →
          </Link>
        )}
      </div>

      <ErrorLine error={account.error ?? setStatus.error} />

      {account.isLoading ? (
        <Loading />
      ) : account.data === undefined ? (
        <Loading>No such account, or not one this login may see.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Number',
              'Owner',
              'Type',
              'State',
              { label: 'Balance', right: true },
              { label: 'Leverage', right: true },
              { label: 'Positions', right: true },
              'Opened',
              { label: 'Actions', right: true },
            ]}
          />
          <tbody>
            <AccountRow
              account={account.data}
              adjusting
              onAdjustToggle={() => undefined}
              onStatus={(status, reason) =>
                setStatus.mutate({ accountId: account.data.id, status, reason })
              }
              busy={setStatus.isPending}
              gate={setStatus}
            />
          </tbody>
        </Table>
      )}
      {account.data === undefined ? null : (
        <FeeScheduleControl
          accountId={account.data.id}
          current={account.data.feeSchedule ?? null}
        />
      )}
    </div>
  );
}

/**
 * Which commission this account pays. A change applies from its next order
 * and is audited with the reason given; what was charged stays charged.
 */
function FeeScheduleControl({
  accountId,
  current,
}: {
  accountId: string;
  current: { id: string; name: string } | null;
}) {
  const schedules = useFeeSchedules();
  const assign = useAssignFeeSchedule();
  const [choice, setChoice] = useState<string>(current?.id ?? '');
  const [reason, setReason] = useState('');
  const changed = choice !== (current?.id ?? '');

  return (
    <section
      className="space-y-2 border-t border-terminal-border p-3"
      data-testid="account-fee-schedule"
    >
      <h2 className="text-sm font-semibold text-terminal-text">Commission</h2>
      <p className="text-caption text-terminal-muted">
        Pays{' '}
        <span className="text-terminal-text">
          {current === null ? 'the instruments’ standard rates' : `the ${current.name} schedule`}
        </span>
        . Schedules are set under{' '}
        <Link href="/admin/fees" className="text-terminal-accent hover:underline">
          Fees
        </Link>
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Commission schedule"
          className={cn(wordInputClass, 'w-auto py-1')}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="">Standard rates</option>
          {(schedules.data?.schedules ?? []).map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.name}
            </option>
          ))}
        </select>
        {changed ? (
          <>
            <input
              className={cn(inputClass, 'w-64 py-1 text-xs')}
              placeholder="Why (kept in the audit log)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              variant="neutral"
              className="px-2 py-1"
              gate={assign}
              disabled={reason.trim().length < 3 || assign.isPending}
              onClick={() =>
                assign.mutate(
                  { accountId, scheduleId: choice === '' ? null : choice, reason: reason.trim() },
                  { onSuccess: () => setReason('') },
                )
              }
            >
              {assign.isPending ? 'Saving…' : 'Apply'}
            </Button>
          </>
        ) : null}
      </div>
      <ErrorLine error={schedules.error ?? assign.error} />
    </section>
  );
}
