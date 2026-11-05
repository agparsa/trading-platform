'use client';

import { useEffect, useMemo, useState } from 'react';
import { DomainError } from '@tp/shared-types';
import { AppShell } from '@/components/shell/app-shell';
import {
  Button,
  EmptyState,
  Field,
  Panel,
  inputClass,
  wordInputClass,
} from '@/components/primitives';
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
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

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
  const t = useT();
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
    <AppShell title={t('nav.wallet')} description={t('wallet.description')}>
      {wallets.isLoading ? (
        <EmptyState>{t('common.loading')}</EmptyState>
      ) : rows.length === 0 ? (
        <div className="space-y-4">
          <EmptyState>{t('wallet.none')}</EmptyState>
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
                      ? 'rounded bg-terminal-raised px-2 py-1 text-caption text-terminal-text'
                      : 'rounded px-2 py-1 text-caption text-terminal-muted hover:text-terminal-text'
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
                <p className="text-label uppercase tracking-wider text-terminal-muted">
                  {t('wallet.ofCurrency', { currency: wallet.currency })}
                </p>
                <p className="numeric mt-1 text-2xl text-terminal-text">
                  {money(wallet.balance, wallet.currency)}
                </p>
                {wallet.status === 'FROZEN' ? (
                  <p className="mt-2 text-caption text-terminal-warning">
                    {t('wallet.frozenNote')}
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
                <table className="w-full text-caption">
                  <thead>
                    <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
                      <th className="px-3 py-2">{t('wallet.col.when')}</th>
                      <th className="px-3 py-2">{t('wallet.col.what')}</th>
                      <th className="px-3 py-2 text-end">{t('col.amount')}</th>
                      <th className="px-3 py-2 text-end">{t('wallet.col.balanceAfter')}</th>
                      <th className="px-3 py-2">{t('col.note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(movements.data?.transactions ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-terminal-muted">
                          {t('wallet.noMovements')}
                        </td>
                      </tr>
                    ) : (
                      (movements.data?.transactions ?? []).map((row) => (
                        <tr key={row.id} className="border-t border-terminal-border/60">
                          <td className="numeric px-3 py-1.5 text-terminal-muted">
                            {utcTime(row.createdAt)}
                          </td>
                          <td className="px-3 py-1.5 text-terminal-text">{label(row.type, t)}</td>
                          <td
                            className={`numeric px-3 py-1.5 text-end ${toneClass[toneOf(row.amount)]}`}
                          >
                            {signedMoney(row.amount, row.currency)}
                          </td>
                          <td className="numeric px-3 py-1.5 text-end text-terminal-muted">
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

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

const MOVEMENT_LABELS: Record<string, MessageKey> = {
  TRANSFER_OUT: 'wallet.move.TRANSFER_OUT',
  TRANSFER_IN: 'wallet.move.TRANSFER_IN',
  DEPOSIT: 'wallet.move.DEPOSIT',
  WITHDRAWAL: 'wallet.move.WITHDRAWAL',
  ADJUSTMENT: 'wallet.move.ADJUSTMENT',
  FEE: 'wallet.move.FEE',
};

/** A code in words, through a table; a code the table does not know is shown as it is. */
function wordsFor(table: Record<string, MessageKey>, code: string, t: Translate): string {
  const key = table[code];
  return key === undefined ? code : t(key);
}

function label(type: string, t: Translate): string {
  return wordsFor(MOVEMENT_LABELS, type, t);
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
  const t = useT();

  useEffect(() => {
    if (accountId === '' && accounts.length > 0) setAccountId(accounts[0]?.id ?? '');
  }, [accountId, accounts]);

  /**
   * Refused here as well as by the server, and the server is the one that counts.
   * This exists so the trader is told before a round trip, not instead of one.
   */
  const blocked = useMemo(() => {
    if (wallet.status === 'FROZEN') return t('wallet.blocked.frozen');
    if (accounts.length === 0) return t('wallet.blocked.noAccount', { currency: wallet.currency });
    if (accountId === '') return t('wallet.blocked.chooseAccount');
    if (!/^\d+(\.\d{1,10})?$/.test(amount.trim())) return t('wallet.blocked.enterAmount');
    if (Number(amount) <= 0) return t('wallet.blocked.positive');
    return null;
  }, [wallet, accounts, accountId, amount, t]);

  return (
    <Panel className="max-w-lg space-y-3 p-4">
      <p className="text-label uppercase tracking-wider text-terminal-muted">{t('wallet.move')}</p>

      <Field label={t('wallet.direction')}>
        <select
          className={wordInputClass}
          value={direction}
          onChange={(event) => setDirection(event.target.value as 'to-account' | 'to-wallet')}
        >
          <option value="to-account">{t('wallet.direction.toAccount')}</option>
          <option value="to-wallet">{t('wallet.direction.toWallet')}</option>
        </select>
      </Field>

      <Field label={t('nav.account')}>
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

      <Field label={t('wallet.amountIn', { currency: wallet.currency })}>
        <input
          className={inputClass}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
        />
      </Field>

      {error === null || error === undefined ? null : (
        <p className="text-caption text-terminal-short">
          {error instanceof DomainError ? error.message : t('wallet.transferFailed')}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={blocked !== null || busy}
          onClick={() => onSubmit({ accountId, direction, amount: amount.trim() })}
        >
          {busy ? t('wallet.moving') : t('wallet.moveButton')}
        </Button>
        {blocked === null ? null : (
          <span className="text-caption text-terminal-muted">{blocked}</span>
        )}
      </div>

      {direction === 'to-wallet' ? (
        <p className="text-label leading-relaxed text-terminal-muted">
          {t('wallet.freeMarginNote')}
        </p>
      ) : null}
    </Panel>
  );
}

/** How a machine name reads to a person. Unknown names are shown as they are. */
const PROVIDER_LABELS: Record<string, MessageKey> = {
  'manual-bank-transfer': 'wallet.provider.bankTransfer',
};

const PAYMENT_STATUS_LABELS: Record<string, MessageKey> = {
  REQUIRES_ACTION: 'wallet.payment.REQUIRES_ACTION',
  PROCESSING: 'wallet.payment.PROCESSING',
  SUCCEEDED: 'wallet.payment.SUCCEEDED',
  FAILED: 'wallet.payment.FAILED',
  CANCELLED: 'wallet.payment.CANCELLED',
  EXPIRED: 'wallet.payment.EXPIRED',
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
  const t = useT();

  useEffect(() => {
    if (provider === '' && providers.length > 0) setProvider(providers[0] ?? '');
  }, [provider, providers]);

  const blocked = useMemo(() => {
    if (providers.length === 0) return 'no-providers';
    if (provider === '') return t('wallet.blocked.chooseProvider');
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return t('wallet.blocked.enterAmount');
    if (Number(amount) <= 0) return t('wallet.blocked.positive');
    return null;
  }, [providers, provider, amount, t]);

  if (providers.length === 0) {
    return (
      <Panel className="max-w-lg p-4">
        <p className="text-label uppercase tracking-wider text-terminal-muted">
          {t('wallet.addMoney')}
        </p>
        <p className="mt-2 text-caption leading-relaxed text-terminal-muted">
          {t('wallet.noProviders')}
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="max-w-lg space-y-3 p-4">
      <p className="text-label uppercase tracking-wider text-terminal-muted">
        {t('wallet.addMoney')}
      </p>

      <Field label={t('wallet.how')}>
        <select
          className={wordInputClass}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {providers.map((name) => (
            <option key={name} value={name}>
              {wordsFor(PROVIDER_LABELS, name, t)}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('wallet.amountIn', { currency })}>
        <input
          className={inputClass}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
        />
      </Field>

      {error === null || error === undefined ? null : (
        <p className="text-caption text-terminal-short">
          {error instanceof DomainError ? error.message : t('wallet.depositFailed')}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={blocked !== null || busy}
          onClick={() => onSubmit({ provider, amount: amount.trim(), currency })}
        >
          {busy ? t('wallet.starting') : t('wallet.continue')}
        </Button>
        {blocked === null || blocked === 'no-providers' ? null : (
          <span className="text-caption text-terminal-muted">{blocked}</span>
        )}
      </div>

      <p className="text-label leading-relaxed text-terminal-muted">{t('wallet.depositNote')}</p>
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
  const t = useT();
  if (payments.length === 0) return null;

  const awaiting = payments.filter((row) => row.status === 'REQUIRES_ACTION');

  return (
    <div className="space-y-4">
      {awaiting.map((row) =>
        row.instructions === null ? null : (
          <Panel key={row.id} className="max-w-lg p-4">
            <p className="text-label uppercase tracking-wider text-terminal-muted">
              {t('wallet.awaitingTransfer', { amount: money(row.amount, row.currency) })}
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-terminal-text">
              {row.instructions}
            </pre>
          </Panel>
        ),
      )}

      <Panel className="overflow-auto">
        <table className="w-full text-caption">
          <thead>
            <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
              <th className="px-3 py-2">{t('wallet.col.started')}</th>
              <th className="px-3 py-2">{t('wallet.how')}</th>
              <th className="px-3 py-2 text-end">{t('col.amount')}</th>
              <th className="px-3 py-2">{t('col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-text">
                  {wordsFor(PROVIDER_LABELS, row.provider, t)}
                </td>
                <td className="numeric px-3 py-1.5 text-end text-terminal-text">
                  {money(row.amount, row.currency)}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {wordsFor(PAYMENT_STATUS_LABELS, row.status, t)}
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

const WITHDRAWAL_STATUS_LABELS: Record<string, MessageKey> = {
  REQUESTED: 'wallet.withdrawal.REQUESTED',
  UNDER_REVIEW: 'wallet.withdrawal.UNDER_REVIEW',
  APPROVED: 'wallet.withdrawal.APPROVED',
  PROCESSING: 'wallet.withdrawal.PROCESSING',
  PAID: 'wallet.withdrawal.PAID',
  REJECTED: 'wallet.withdrawal.REJECTED',
  CANCELLED: 'wallet.withdrawal.CANCELLED',
  FAILED: 'wallet.withdrawal.FAILED',
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
  const t = useT();

  const blocked = useMemo(() => {
    if (wallet.status === 'FROZEN') return t('wallet.blocked.frozen');
    if (terms.data?.identityRequired === true && terms.data.identityVerified === false) {
      return t('wallet.blocked.verifyFirst');
    }
    if (terms.data?.nextAllowedAt !== null && terms.data?.nextAllowedAt !== undefined) {
      return t('wallet.blocked.nextFrom', { time: utcTime(terms.data.nextAllowedAt) });
    }
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return t('wallet.blocked.enterAmount');
    if (Number(amount) <= 0) return t('wallet.blocked.positive');
    if (destination.trim().length < 8) return t('wallet.blocked.destination');
    return null;
  }, [wallet, terms.data, amount, destination, t]);

  return (
    <div className="space-y-4">
      <Panel className="max-w-lg space-y-3 p-4">
        <p className="text-label uppercase tracking-wider text-terminal-muted">
          {t('wallet.withdraw')}
        </p>

        {terms.data === undefined ? null : (
          <p className="text-caption leading-relaxed text-terminal-muted">
            {t('wallet.withdraw.range', {
              minimum: money(terms.data.minimum, wallet.currency),
              maximum: money(terms.data.maximum, wallet.currency),
            })}
            {terms.data.dailyLimit === null
              ? ''
              : t('wallet.withdraw.daily', {
                  remaining: money(terms.data.remainingToday ?? '0', wallet.currency),
                  limit: money(terms.data.dailyLimit, wallet.currency),
                })}
            {t('wallet.withdraw.end')}
            {terms.data.identityRequired && !terms.data.identityVerified ? (
              <>
                {' '}
                {t('wallet.withdraw.identityBefore')}{' '}
                <a href="/verification" className="underline">
                  {t('nav.verification')}
                </a>{' '}
                {t('wallet.withdraw.identityAfter')}
              </>
            ) : null}
          </p>
        )}

        <Field label={t('wallet.amountIn', { currency: wallet.currency })}>
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('wallet.payTo')}>
          <textarea
            className={`${wordInputClass} min-h-[4rem]`}
            dir="auto"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder={t('wallet.payTo.placeholder')}
            maxLength={500}
          />
        </Field>

        {error === null || error === undefined ? null : (
          <p className="text-caption text-terminal-short">
            {error instanceof DomainError ? error.message : t('wallet.requestFailed')}
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
            {busy ? t('login.working') : t('wallet.requestWithdrawal')}
          </Button>
          {blocked === null ? null : (
            <span className="text-caption text-terminal-muted">{blocked}</span>
          )}
        </div>

        <p className="text-label leading-relaxed text-terminal-muted">{t('wallet.withdrawNote')}</p>
      </Panel>

      {withdrawals.length === 0 ? null : (
        <Panel className="overflow-auto">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
                <th className="px-3 py-2">{t('wallet.col.requested')}</th>
                <th className="px-3 py-2 text-end">{t('col.amount')}</th>
                <th className="px-3 py-2">{t('wallet.col.to')}</th>
                <th className="px-3 py-2">{t('col.status')}</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((row) => (
                <tr key={row.id} className="border-t border-terminal-border/60">
                  <td className="numeric px-3 py-1.5 text-terminal-muted">
                    {utcTime(row.createdAt)}
                  </td>
                  <td className="numeric px-3 py-1.5 text-end text-terminal-text">
                    {money(row.amount, row.currency)}
                  </td>
                  <td className="px-3 py-1.5 text-terminal-muted">…{row.destinationHint}</td>
                  <td className="px-3 py-1.5 text-terminal-muted">
                    {wordsFor(WITHDRAWAL_STATUS_LABELS, row.status, t)}
                    {row.reason === null ? '' : ` — ${row.reason}`}
                    {row.providerReference === null
                      ? ''
                      : ` (${t('wallet.ref', { reference: row.providerReference })})`}
                  </td>
                  <td className="px-3 py-1.5 text-end">
                    {row.canCancel ? (
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={busy}
                        onClick={() => onCancel(row.id)}
                      >
                        {t('wallet.cancel')}
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
