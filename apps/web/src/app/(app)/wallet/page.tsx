'use client';

import { useEffect, useMemo, useState } from 'react';
import { DomainError } from '@tp/shared-types';
import { AppShell } from '@/components/shell/app-shell';
import { Button, EmptyState, Field, Panel, inputClass } from '@/components/primitives';
import { money, signedMoney, toneClass, toneOf, utcTime } from '@/lib/format';
import {
  useAccounts,
  useWalletTransactions,
  useWalletTransfer,
  useWallets,
  type WalletRow,
} from '@/lib/queries';

/**
 * Money that is yours but not in any trading account.
 *
 * The two numbers on this page come from two different ledgers and that is the
 * point: a wallet balance and an account balance are authoritative for different
 * pots, and a transfer moves money between them without either being able to
 * invent it. See docs/wallet.md.
 *
 * There is no deposit button. There is no payment provider — §50 says not to
 * build UI for functionality that does not exist, and a button that opened a
 * form and then failed would be worse than its absence. Money arrives today by
 * an operator recording a bank transfer, which is an administrative action with
 * its own screen.
 */
export default function WalletPage() {
  const wallets = useWallets();
  const accounts = useAccounts();
  const transfer = useWalletTransfer();

  const rows = wallets.data?.wallets ?? [];
  const [walletId, setWalletId] = useState<string | null>(null);
  useEffect(() => {
    if (walletId === null && rows.length > 0) setWalletId(rows[0]?.id ?? null);
  }, [walletId, rows]);

  const wallet = rows.find((row) => row.id === walletId);
  const movements = useWalletTransactions(walletId);

  return (
    <AppShell
      title="Wallet"
      description="Money held for you, and the trading accounts you can move it between."
    >
      {wallets.isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>
          No wallet yet. One is created the first time money arrives or you move some out of a
          trading account.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {rows.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setWalletId(row.id)}
                  aria-pressed={row.id === walletId}
                  className={
                    row.id === walletId
                      ? 'rounded bg-terminal-raised px-2 py-1 text-[11px] text-terminal-text'
                      : 'rounded px-2 py-1 text-[11px] text-terminal-muted hover:text-terminal-text'
                  }
                >
                  {row.currency}
                </button>
              ))}
            </div>
          ) : null}

          {wallet === undefined ? null : (
            <>
              <Panel className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
                  {wallet.currency} wallet
                </p>
                <p className="numeric mt-1 text-2xl text-terminal-text">
                  {money(wallet.balance, wallet.currency)}
                </p>
                {wallet.status === 'FROZEN' ? (
                  <p className="mt-2 text-[11px] text-terminal-warning">
                    This wallet is frozen while it is reviewed. The money is held, not taken, and it
                    moves again when the hold is lifted.
                  </p>
                ) : null}
              </Panel>

              <TransferForm
                wallet={wallet}
                accounts={(accounts.data ?? []).filter(
                  (account) => account.currency === wallet.currency,
                )}
                busy={transfer.isPending}
                error={transfer.error}
                onSubmit={(input) => transfer.mutate(input)}
              />

              <Panel className="overflow-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
                      <th className="px-3 py-2">When</th>
                      <th className="px-3 py-2">What</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-right">Balance after</th>
                      <th className="px-3 py-2">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(movements.data?.transactions ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-terminal-muted">
                          Nothing has moved yet.
                        </td>
                      </tr>
                    ) : (
                      (movements.data?.transactions ?? []).map((row) => (
                        <tr key={row.id} className="border-t border-terminal-border/60">
                          <td className="numeric px-3 py-1.5 text-terminal-muted">
                            {utcTime(row.createdAt)}
                          </td>
                          <td className="px-3 py-1.5 text-terminal-text">{label(row.type)}</td>
                          <td
                            className={`numeric px-3 py-1.5 text-right ${toneClass[toneOf(row.amount)]}`}
                          >
                            {signedMoney(row.amount, row.currency)}
                          </td>
                          <td className="numeric px-3 py-1.5 text-right text-terminal-muted">
                            {money(row.balanceAfter, row.currency)}
                          </td>
                          <td className="px-3 py-1.5 text-terminal-muted">
                            {row.description ?? '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </Panel>
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}

function label(type: string): string {
  switch (type) {
    case 'TRANSFER_OUT':
      return 'To trading account';
    case 'TRANSFER_IN':
      return 'From trading account';
    case 'DEPOSIT':
      return 'Deposit';
    case 'WITHDRAWAL':
      return 'Withdrawal';
    case 'ADJUSTMENT':
      return 'Correction';
    default:
      return type;
  }
}

function TransferForm({
  wallet,
  accounts,
  busy,
  error,
  onSubmit,
}: {
  wallet: WalletRow;
  accounts: readonly { id: string; number: string; currency: string }[];
  busy: boolean;
  error: unknown;
  onSubmit: (input: {
    accountId: string;
    direction: 'to-account' | 'to-wallet';
    amount: string;
  }) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [direction, setDirection] = useState<'to-account' | 'to-wallet'>('to-account');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (accountId === '' && accounts.length > 0) setAccountId(accounts[0]?.id ?? '');
  }, [accountId, accounts]);

  /**
   * Refused here as well as by the server, and the server is the one that counts.
   * This exists so the trader is told before a round trip, not instead of one.
   */
  const blocked = useMemo(() => {
    if (wallet.status === 'FROZEN') return 'This wallet is frozen.';
    if (accounts.length === 0)
      return `No ${wallet.currency} trading account to move money between.`;
    if (accountId === '') return 'Choose an account.';
    if (!/^\d+(\.\d{1,10})?$/.test(amount.trim())) return 'Enter an amount.';
    if (Number(amount) <= 0) return 'The amount must be more than zero.';
    return null;
  }, [wallet, accounts, accountId, amount]);

  return (
    <Panel className="max-w-lg space-y-3 p-4">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Move money</p>

      <Field label="Direction">
        <select
          className={inputClass}
          value={direction}
          onChange={(event) => setDirection(event.target.value as 'to-account' | 'to-wallet')}
        >
          <option value="to-account">Wallet → trading account</option>
          <option value="to-wallet">Trading account → wallet</option>
        </select>
      </Field>

      <Field label="Account">
        <select
          className={inputClass}
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              #{account.number}
            </option>
          ))}
        </select>
      </Field>

      <Field label={`Amount (${wallet.currency})`}>
        <input
          className={inputClass}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
        />
      </Field>

      {error === null || error === undefined ? null : (
        <p className="text-[11px] text-terminal-negative">
          {error instanceof DomainError ? error.message : 'The transfer did not go through.'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={blocked !== null || busy}
          onClick={() => onSubmit({ accountId, direction, amount: amount.trim() })}
        >
          {busy ? 'Moving…' : 'Move'}
        </Button>
        {blocked === null ? null : (
          <span className="text-[11px] text-terminal-muted">{blocked}</span>
        )}
      </div>

      {direction === 'to-wallet' ? (
        <p className="text-[10px] leading-relaxed text-terminal-muted">
          Only free margin can leave a trading account. Money committed to an open position stays
          where it is — taking it would close the position, from here, at a price nobody chose.
        </p>
      ) : null}
    </Panel>
  );
}
