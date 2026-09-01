'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AccountRow } from '@/components/admin/accounts-panel';
import { ErrorLine, Head, Loading, Table } from '@/components/admin/shared';
import { useAdminAccount, useSetAccountStatus } from '@/lib/admin-queries';

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
          className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ← All accounts
        </Link>
        {account.data === undefined ? null : (
          <Link
            href={`/admin/people/${account.data.userId}`}
            className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
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
            />
          </tbody>
        </Table>
      )}
    </div>
  );
}
