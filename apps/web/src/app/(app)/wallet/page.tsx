'use client';

import { useEffect, useMemo, useState } from 'react';
import { DomainError } from '@tp/shared-types';
import { AppShell } from '@/components/shell/app-shell';
import { Button, EmptyState, Field, Panel, inputClass } from '@/components/primitives';
import { money, signedMoney, toneClass, toneOf, utcTime } from '@/lib/format';
import {
  useAccounts,
  useCancelWithdrawal,
  usePaymentProviders,
  usePayments,
  useRequestWithdrawal,
  useStartPayment,
  useWalletTransactions,
  useWalletTransfer,
  useWallets,
  useWithdrawalTerms,
  useWithdrawals,
  type PaymentRow,
  type WalletRow,
  type WithdrawalRow,
} from '@/lib/queries';

/**
 * Money that is yours but not in any trading account.
 *
 * The two numbers on this page come from two different ledgers and that is the
 * point: a wallet balance and an account balance are authoritative for different
 * pots, and a transfer moves money between them without either being able to
 * invent it. See docs/wallet.md.
 *
 * The deposit form offers whatever the *server* says it has, which today is a
 * bank transfer and nothing else. No card logos, no wallet icons: a button for
 * a provider nobody has signed a contract with is a button that fails on
 * submit, and §50 is explicit that UI must not be built for functionality that
 * does not exist.
 *
 * Nothing on this page makes the balance move. A deposit is an instruction to
 * the payer; the money appears when the provider says it has it, or when
 * somebody here matches the transfer to its reference.
 */
export default function WalletPage() {
  const wallets = useWallets();
  const accounts = useAccounts();
  const transfer = useWalletTransfer();
  const providers = usePaymentProviders();
  const payments = usePayments();
  const startPayment = useStartPayment();
  const withdrawals = useWithdrawals();
  const requestWithdrawal = useRequestWithdrawal();
  const cancelWithdrawal = useCancelWithdrawal();

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
        <div className="space-y-4">
          <EmptyState>
            No wallet yet. One is created the first time money arrives or you move some out of a
            trading account.
          </EmptyState>
          <DepositForm
            providers={providers.data?.providers ?? []}
            currency="USD"
            busy={startPayment.isPending}
            error={startPayment.error}
            onSubmit={(input) => startPayment.mutate(input)}
          />
          <PaymentHistory payments={payments.data?.payments ?? []} />
        </div>
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

              <DepositForm
                providers={providers.data?.providers ?? []}
                currency={wallet.currency}
                busy={startPayment.isPending}
                error={startPayment.error}
                onSubmit={(input) => startPayment.mutate(input)}
              />

              <PaymentHistory
                payments={(payments.data?.payments ?? []).filter(
                  (row) => row.currency === wallet.currency,
                )}
              />

              <WithdrawSection
                wallet={wallet}
                withdrawals={(withdrawals.data?.withdrawals ?? []).filter(
                  (row) => row.currency === wallet.currency,
                )}
                busy={requestWithdrawal.isPending || cancelWithdrawal.isPending}
                error={requestWithdrawal.error ?? cancelWithdrawal.error}
                onRequest={(input) => requestWithdrawal.mutate(input)}
                onCancel={(id) => cancelWithdrawal.mutate({ id })}
              />

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

/** How a machine name reads to a person. Unknown names are shown as they are. */
const PROVIDER_LABELS: Record<string, string> = {
  'manual-bank-transfer': 'Bank transfer',
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  REQUIRES_ACTION: 'Awaiting your transfer',
  PROCESSING: 'With the provider',
  SUCCEEDED: 'Received',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

/**
 * Starting a deposit.
 *
 * The provider list comes from the server. When it is empty this renders a
 * sentence saying so rather than a disabled form, because a form nothing can
 * submit is a worse answer to "how do I add money" than being told plainly.
 */
function DepositForm({
  providers,
  currency,
  busy,
  error,
  onSubmit,
}: {
  providers: readonly string[];
  currency: string;
  busy: boolean;
  error: unknown;
  onSubmit: (input: { provider: string; amount: string; currency: string }) => void;
}) {
  const [provider, setProvider] = useState('');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (provider === '' && providers.length > 0) setProvider(providers[0] ?? '');
  }, [provider, providers]);

  const blocked = useMemo(() => {
    if (providers.length === 0) return 'no-providers';
    if (provider === '') return 'Choose how you want to pay.';
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return 'Enter an amount.';
    if (Number(amount) <= 0) return 'The amount must be more than zero.';
    return null;
  }, [providers, provider, amount]);

  if (providers.length === 0) {
    return (
      <Panel className="max-w-lg p-4">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Add money</p>
        <p className="mt-2 text-[11px] leading-relaxed text-terminal-muted">
          No payment method is configured on this deployment yet. Ask support how to send funds —
          they can record a transfer against your account once it arrives.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="max-w-lg space-y-3 p-4">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Add money</p>

      <Field label="How">
        <select
          className={inputClass}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {providers.map((name) => (
            <option key={name} value={name}>
              {PROVIDER_LABELS[name] ?? name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={`Amount (${currency})`}>
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
          {error instanceof DomainError ? error.message : 'The deposit could not be started.'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={blocked !== null || busy}
          onClick={() => onSubmit({ provider, amount: amount.trim(), currency })}
        >
          {busy ? 'Starting…' : 'Continue'}
        </Button>
        {blocked === null || blocked === 'no-providers' ? null : (
          <span className="text-[11px] text-terminal-muted">{blocked}</span>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-terminal-muted">
        This does not move any money. You will be shown what to do next, and your balance changes
        once the transfer has actually arrived.
      </p>
    </Panel>
  );
}

/**
 * Deposits and what became of them.
 *
 * The instructions for an unpaid one are shown here rather than only once at the
 * moment it was started: the reference is the single thing tying a line on a
 * bank statement to this person, and somebody who closed the tab needs to be
 * able to find it again.
 */
function PaymentHistory({ payments }: { payments: readonly PaymentRow[] }) {
  if (payments.length === 0) return null;

  const awaiting = payments.filter((row) => row.status === 'REQUIRES_ACTION');

  return (
    <div className="space-y-4">
      {awaiting.map((row) =>
        row.instructions === null ? null : (
          <Panel key={row.id} className="max-w-lg p-4">
            <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
              Awaiting your transfer — {money(row.amount, row.currency)}
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-terminal-text">
              {row.instructions}
            </pre>
          </Panel>
        ),
      )}

      <Panel className="overflow-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2">How</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-text">
                  {PROVIDER_LABELS[row.provider] ?? row.provider}
                </td>
                <td className="numeric px-3 py-1.5 text-right text-terminal-text">
                  {money(row.amount, row.currency)}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {PAYMENT_STATUS_LABELS[row.status] ?? row.status}
                  {row.failureReason === null ? '' : ` — ${row.failureReason}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

const WITHDRAWAL_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Requested',
  UNDER_REVIEW: 'Being reviewed',
  APPROVED: 'Approved, awaiting payment',
  PROCESSING: 'Transfer sent',
  PAID: 'Paid',
  REJECTED: 'Not approved',
  CANCELLED: 'Cancelled',
  FAILED: 'Transfer failed',
};

/**
 * Money out.
 *
 * The one thing this section must say plainly: the wallet is debited the
 * moment a request is made, not when it is paid. The balance above goes down
 * on submit, and comes back only if the request is refused, cancelled or the
 * transfer fails. A screen that showed the old balance beside a pending
 * withdrawal would be showing money that could be spent twice.
 *
 * The terms come from the server before anything is typed, so a person is not
 * told "your identity must be verified" after filling in a bank account.
 */
function WithdrawSection({
  wallet,
  withdrawals,
  busy,
  error,
  onRequest,
  onCancel,
}: {
  wallet: WalletRow;
  withdrawals: readonly WithdrawalRow[];
  busy: boolean;
  error: unknown;
  onRequest: (input: { walletId: string; amount: string; destination: string }) => void;
  onCancel: (id: string) => void;
}) {
  const terms = useWithdrawalTerms(wallet.currency);
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');

  const blocked = useMemo(() => {
    if (wallet.status === 'FROZEN') return 'This wallet is frozen.';
    if (terms.data?.identityRequired === true && terms.data.identityVerified === false) {
      return 'Verify your identity first.';
    }
    if (terms.data?.nextAllowedAt !== null && terms.data?.nextAllowedAt !== undefined) {
      return `Next request from ${utcTime(terms.data.nextAllowedAt)}.`;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return 'Enter an amount.';
    if (Number(amount) <= 0) return 'The amount must be more than zero.';
    if (destination.trim().length < 8) return 'Say where the money should go.';
    return null;
  }, [wallet, terms.data, amount, destination]);

  return (
    <div className="space-y-4">
      <Panel className="max-w-lg space-y-3 p-4">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Withdraw</p>

        {terms.data === undefined ? null : (
          <p className="text-[11px] leading-relaxed text-terminal-muted">
            Between {money(terms.data.minimum, wallet.currency)} and{' '}
            {money(terms.data.maximum, wallet.currency)} per request
            {terms.data.dailyLimit === null
              ? ''
              : `; ${money(terms.data.remainingToday ?? '0', wallet.currency)} of today's ${money(terms.data.dailyLimit, wallet.currency)} remains`}
            .
            {terms.data.identityRequired && !terms.data.identityVerified ? (
              <>
                {' '}
                Your identity has to be verified before money can be paid out — see the{' '}
                <a href="/verification" className="underline">
                  Verification
                </a>{' '}
                page.
              </>
            ) : null}
          </p>
        )}

        <Field label={`Amount (${wallet.currency})`}>
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label="Pay to">
          <textarea
            className={`${inputClass} min-h-[4rem]`}
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="Account name, and the account number or IBAN, as your bank would want it"
            maxLength={500}
          />
        </Field>

        {error === null || error === undefined ? null : (
          <p className="text-[11px] text-terminal-negative">
            {error instanceof DomainError ? error.message : 'The request did not go through.'}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            disabled={blocked !== null || busy}
            onClick={() => {
              onRequest({
                walletId: wallet.id,
                amount: amount.trim(),
                destination: destination.trim(),
              });
              setAmount('');
              setDestination('');
            }}
          >
            {busy ? 'Working…' : 'Request withdrawal'}
          </Button>
          {blocked === null ? null : (
            <span className="text-[11px] text-terminal-muted">{blocked}</span>
          )}
        </div>

        <p className="text-[10px] leading-relaxed text-terminal-muted">
          The amount leaves your wallet balance the moment you ask, and comes back only if the
          request is refused, cancelled, or the transfer fails. Somebody reviews every request and a
          person sends the money; you will be told when it is paid.
        </p>
      </Panel>

      {withdrawals.length === 0 ? null : (
        <Panel className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
                <th className="px-3 py-2">Requested</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((row) => (
                <tr key={row.id} className="border-t border-terminal-border/60">
                  <td className="numeric px-3 py-1.5 text-terminal-muted">
                    {utcTime(row.createdAt)}
                  </td>
                  <td className="numeric px-3 py-1.5 text-right text-terminal-text">
                    {money(row.amount, row.currency)}
                  </td>
                  <td className="px-3 py-1.5 text-terminal-muted">…{row.destinationHint}</td>
                  <td className="px-3 py-1.5 text-terminal-muted">
                    {WITHDRAWAL_STATUS_LABELS[row.status] ?? row.status}
                    {row.reason === null ? '' : ` — ${row.reason}`}
                    {row.providerReference === null ? '' : ` (ref ${row.providerReference})`}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {row.canCancel ? (
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={busy}
                        onClick={() => onCancel(row.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
