'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass } from '@/components/primitives';
import {
  useAdjustBalance,
  useAdminAccounts,
  useSetAccountStatus,
  type AdminAccountRow,
} from '@/lib/admin-queries';
import { money, signedMoney, utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, SearchBox, StatusPill, Table } from './shared';

const STATUSES = ['ACTIVE', 'RESTRICTED', 'CLOSE_ONLY', 'SUSPENDED', 'CLOSED'] as const;

/**
 * Accounts.
 *
 * `CLOSE_ONLY` is offered beside the full freeze because the answer to "this
 * account is in trouble" should not be forced to be "stop it dead". A trader who
 * may still close can reduce their own risk; one frozen with positions open has
 * had their hands tied around a live exposure, and the platform then owns it.
 */
export function AccountsPanel() {
  const [search, setSearch] = useState('');
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const accounts = useAdminAccounts(search);
  const setStatus = useSetAccountStatus();

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Account number or email" />
        <span className="text-[10px] text-terminal-muted">
          {accounts.data === undefined ? '' : `${accounts.data.length} shown`}
        </span>
      </div>

      <ErrorLine error={accounts.error ?? setStatus.error} />

      {accounts.isLoading ? (
        <Loading />
      ) : (accounts.data ?? []).length === 0 ? (
        <Loading>No accounts match that.</Loading>
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
            {(accounts.data ?? []).map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                adjusting={adjusting === account.id}
                onAdjustToggle={() => setAdjusting(adjusting === account.id ? null : account.id)}
                onStatus={(status, reason) =>
                  setStatus.mutate({ accountId: account.id, status, reason })
                }
                busy={setStatus.isPending}
              />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

export function AccountRow({
  account,
  adjusting,
  onAdjustToggle,
  onStatus,
  busy,
}: {
  account: AdminAccountRow;
  adjusting: boolean;
  onAdjustToggle: () => void;
  onStatus: (status: string, reason: string) => void;
  busy: boolean;
}) {
  const [status, setStatus] = useState<string>(account.status);

  return (
    <>
      <tr className="border-t border-terminal-border/60 hover:bg-terminal-raised/30">
        <td className="numeric px-2 py-1.5 text-terminal-text">{account.number}</td>
        <td className="px-2 py-1.5 text-terminal-muted">{account.email}</td>
        <td className="px-2 py-1.5 text-terminal-muted">{account.type}</td>
        <td className="px-2 py-1.5">
          <StatusPill status={account.status} />
        </td>
        <td className="numeric px-2 py-1.5 text-right text-terminal-text">
          {money(account.balance, account.currency)}
        </td>
        <td className="numeric px-2 py-1.5 text-right text-terminal-muted">1:{account.leverage}</td>
        <td className="numeric px-2 py-1.5 text-right text-terminal-muted">{account.positions}</td>
        <td className="numeric px-2 py-1.5 text-terminal-muted">{utcTime(account.createdAt)}</td>
        <td className="px-2 py-1.5">
          <div className="flex flex-wrap items-center justify-end gap-1">
            <select
              className={cn(inputClass, 'w-32 py-0.5 text-[11px]')}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label={`Status for ${account.number}`}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <ReasonedAction
              label="Apply"
              title="Why the state is changing"
              variant={status === 'ACTIVE' ? 'neutral' : 'danger'}
              busy={busy}
              onConfirm={(reason) => onStatus(status, reason)}
            />
            <Button variant="ghost" className="px-2 py-0.5" onClick={onAdjustToggle}>
              {adjusting ? 'Close' : 'Adjust'}
            </Button>
          </div>
        </td>
      </tr>
      {adjusting ? (
        <tr className="border-t border-terminal-border/60">
          <td colSpan={9} className="bg-terminal-bg px-3 py-3">
            <AdjustmentForm account={account} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Posting a correcting entry.
 *
 * Everything about this form says what it is: it does not offer a "new balance"
 * field, because there is no endpoint that sets one. It takes a **signed
 * amount**, a reason somebody will read a year from now, and a current code from
 * the administrator's own authenticator — the only action in the platform that
 * asks for a second factor after sign-in, because it is the only one that
 * creates money.
 */
function AdjustmentForm({ account }: { account: AdminAccountRow }) {
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'FEE'>('ADJUSTMENT');
  const [reason, setReason] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const adjust = useAdjustBalance();

  const ready =
    /^-?\d+(\.\d+)?$/.test(amount.trim()) &&
    Number(amount) !== 0 &&
    reason.trim().length >= 8 &&
    totpCode.trim().length >= 6;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-terminal-muted">
        This appends an entry to {account.number}&rsquo;s ledger. Nothing anywhere sets a balance —
        the balance moves because the ledger moved, and the entry stays readable beside the trades
        either side of it. A positive amount credits; a negative amount debits.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
            Amount ({account.currency})
          </span>
          <input
            className={cn(inputClass, 'w-32')}
            inputMode="decimal"
            placeholder="-250.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
            Kind
          </span>
          <select
            className={cn(inputClass, 'w-36')}
            value={type}
            onChange={(event) => setType(event.target.value as typeof type)}
          >
            <option value="ADJUSTMENT">Adjustment</option>
            <option value="DEPOSIT">Deposit</option>
            <option value="WITHDRAWAL">Withdrawal</option>
            <option value="FEE">Fee</option>
          </select>
        </label>

        <label className="block flex-1">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
            Reason (stored on the entry)
          </span>
          <input
            className={cn(inputClass, 'w-full')}
            placeholder="Wire received, reference 88213"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
            Your 2FA code
          </span>
          <input
            className={cn(inputClass, 'w-28')}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
          />
        </label>

        <Button
          variant="danger"
          disabled={!ready || adjust.isPending}
          onClick={() =>
            adjust.mutate(
              {
                accountId: account.id,
                amount: amount.trim(),
                type,
                reason: reason.trim(),
                totpCode: totpCode.trim(),
              },
              {
                onSuccess: () => {
                  setAmount('');
                  setReason('');
                  setTotpCode('');
                },
              },
            )
          }
        >
          {adjust.isPending ? 'Posting…' : 'Post entry'}
        </Button>
      </div>

      <ErrorLine error={adjust.error} />
      {adjust.data === undefined ? null : (
        <p className="text-[11px] text-terminal-long">
          Posted {signedMoney(adjust.data.amount, account.currency)} — balance is now{' '}
          {money(adjust.data.balanceAfter, account.currency)}. Entry {adjust.data.entryId}.
        </p>
      )}
    </div>
  );
}
