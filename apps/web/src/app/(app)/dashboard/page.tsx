'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@tp/ui';
import { AppShell } from '@/components/shell/app-shell';
import { EquityChart } from '@/components/dashboard/equity-chart';
import { SideBadge } from '@/components/primitives';
import { money, percent, signedMoney, toneClass, toneOf, utcTime } from '@/lib/format';
import { wordsFor, type MessageKey } from '@/lib/messages';
import {
  useAccountState,
  useAccounts,
  useKyc,
  useNotifications,
  usePerformance,
  useProfile,
  useTrades,
  useTwoFactorStatus,
  useWallets,
  type AccountStateResponse,
  type AccountSummary,
} from '@/lib/queries';
import { ACCOUNT_STATUS_WORDS, ACCOUNT_TYPE_WORDS } from '@/lib/server-words';
import { useT } from '@/lib/use-locale';

/** How often the dashboard re-reads the account's state; it has no socket. */
const STATE_POLL_MS = 5_000;

/**
 * The trader's home: the account at a glance, how it has gone, what is open,
 * and what is left to do.
 *
 * Every figure is the server's — the account state from `/accounts/:id/state`
 * (re-read every few seconds), the curve from the snapshots, performance from
 * closed trades, wallets, KYC and two-factor from their own endpoints. A
 * section whose source failed says so; nothing is filled in to look complete.
 */
export default function DashboardPage() {
  const t = useT();
  const accounts = useAccounts();
  const profile = useProfile();
  const rows = accounts.data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (rows.length === 0) return;
    if (accountId === null || !rows.some((row) => row.id === accountId)) {
      setAccountId(rows[0]?.id ?? null);
    }
  }, [accountId, rows]);

  const account = rows.find((row) => row.id === accountId);
  const state = useAccountState(accountId, STATE_POLL_MS);
  const name = profile.data?.displayName ?? '';

  return (
    <AppShell
      wide
      title={name === '' ? t('dash.title') : t('dash.hello', { name })}
      description={t('dash.lead')}
    >
      <div className="space-y-4" data-testid="dashboard">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AccountPicker rows={rows} accountId={accountId} onPick={setAccountId} />
          <div className="flex flex-wrap gap-2">
            <Link
              href="/wallet"
              className="rounded-md border border-terminal-border px-3 py-1.5 text-caption text-terminal-text hover:border-terminal-muted"
            >
              {t('more.deposit')}
            </Link>
            <Link
              href="/terminal"
              className="rounded-md bg-terminal-accent px-3 py-1.5 text-caption font-medium text-terminal-bg hover:opacity-90"
              data-testid="dashboard-open-terminal"
            >
              {t('dash.openTerminal')}
            </Link>
          </div>
        </div>

        {accounts.isError ? (
          <Notice tone="error">{t('more.accountsFailed')}</Notice>
        ) : accounts.isPending ? (
          <Notice>{t('common.loading')}</Notice>
        ) : rows.length === 0 ? (
          <Notice>{t('common.noAccounts')}</Notice>
        ) : (
          <Figures account={account} state={state.data} failed={state.isError} />
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <EquityChart accountId={accountId} />
          <div className="space-y-4">
            <Checklist emailVerified={profile.data?.emailVerified} />
            <Wallets />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <OpenPositions state={state.data} failed={state.isError} />
          <Performance accountId={accountId} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <RecentTrades accountId={accountId} currency={account?.currency ?? 'USD'} />
          <RecentNotices />
        </div>
      </div>
    </AppShell>
  );
}

function AccountPicker({
  rows,
  accountId,
  onPick,
}: {
  rows: readonly AccountSummary[];
  accountId: string | null;
  onPick: (id: string) => void;
}) {
  const t = useT();
  if (rows.length === 0) return <span />;
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('more.accounts')}>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onPick(row.id)}
          aria-pressed={row.id === accountId}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-caption',
            row.id === accountId
              ? 'border-terminal-accent/60 bg-terminal-raised text-terminal-text'
              : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
          )}
        >
          <span
            className={cn(
              'rounded px-1 text-micro font-medium uppercase',
              row.type === 'LIVE'
                ? 'bg-terminal-long/15 text-terminal-long'
                : 'bg-terminal-warning/15 text-terminal-warning',
            )}
          >
            {wordsFor(ACCOUNT_TYPE_WORDS, row.type, t)}
          </span>
          <span className="numeric">#{row.number}</span>
        </button>
      ))}
    </div>
  );
}

function Figures({
  account,
  state,
  failed,
}: {
  account: AccountSummary | undefined;
  state: AccountStateResponse | undefined;
  failed: boolean;
}) {
  const t = useT();
  const currency = state?.currency ?? account?.currency ?? 'USD';
  return (
    <section aria-label={t('dash.figures')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card
          label={t('account.balance')}
          value={money(state?.balance ?? account?.balance, currency)}
          strong
        />
        <Card label={t('account.equity')} value={money(state?.equity, currency)} strong />
        <Card
          label={t('account.floating')}
          value={signedMoney(state?.floatingPnl, currency)}
          tone={toneClass[toneOf(state?.floatingPnl)]}
        />
        <Card
          label={t('dash.today')}
          value={signedMoney(state?.realizedPnlToday, currency)}
          tone={toneClass[toneOf(state?.realizedPnlToday)]}
        />
        <Card label={t('account.freeMargin')} value={money(state?.freeMargin, currency)} />
        <Card
          label={t('account.marginLevel')}
          value={state?.marginLevel == null ? '—' : percent(state.marginLevel)}
        />
      </div>
      <p className="mt-2 text-micro text-terminal-muted">
        {failed
          ? t('dash.stateFailed')
          : account === undefined
            ? ''
            : t('dash.accountLine', {
                status: wordsFor(ACCOUNT_STATUS_WORDS, account.status, t),
                leverage: account.leverage,
                currency,
                updated:
                  state === undefined ? '—' : utcTime(new Date(state.updatedAt).toISOString()),
              })}
      </p>
    </section>
  );
}

function Card({
  label,
  value,
  tone,
  strong = false,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-xl border border-terminal-border bg-terminal-surface p-3">
      <p className="text-caption text-terminal-muted">{label}</p>
      <p
        className={cn(
          'numeric mt-1 truncate',
          strong ? 'text-lg font-semibold' : 'text-base',
          tone ?? 'text-terminal-text',
        )}
        dir="ltr"
      >
        {value}
      </p>
    </div>
  );
}

function Box({
  title,
  href,
  link,
  children,
  testId,
}: {
  title: string;
  href?: string;
  link?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-surface"
      data-testid={testId}
    >
      <header className="flex items-center justify-between border-b border-terminal-border px-4 py-3">
        <h2 className="text-sm font-semibold text-terminal-text">{title}</h2>
        {href === undefined ? null : (
          <Link href={href} className="text-caption text-terminal-accent hover:underline">
            {link}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function Checklist({ emailVerified }: { emailVerified: boolean | undefined }) {
  const t = useT();
  const kyc = useKyc();
  const twoFactor = useTwoFactorStatus();
  const items: Array<{ label: MessageKey; done: boolean | undefined; href: string; note: string }> =
    [
      {
        label: 'dash.check.email',
        done: emailVerified,
        href: '/settings',
        note: emailVerified === false ? t('dash.check.emailPending') : '',
      },
      {
        label: 'dash.check.kyc',
        done: kyc.isError ? undefined : kyc.data?.verified,
        href: '/verification',
        note:
          kyc.data === undefined
            ? ''
            : wordsFor(
                {
                  NOT_STARTED: 'kyc.status.NOT_STARTED',
                  PENDING: 'kyc.status.PENDING',
                  UNDER_REVIEW: 'kyc.status.UNDER_REVIEW',
                  VERIFIED: 'kyc.status.VERIFIED',
                  REJECTED: 'kyc.status.REJECTED',
                  EXPIRED: 'kyc.status.EXPIRED',
                },
                kyc.data.status,
                t,
              ),
      },
      {
        label: 'dash.check.twoFactor',
        done: twoFactor.isError ? undefined : twoFactor.data?.enabled,
        href: '/security',
        note: '',
      },
    ];
  const done = items.filter((item) => item.done === true).length;
  return (
    <Box title={t('dash.check.title', { done, total: items.length })} testId="dashboard-checklist">
      <ul className="divide-y divide-terminal-border/60">
        {items.map((item) => (
          <li key={item.label}>
            <Link
              href={item.href}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-terminal-raised/50"
            >
              <span
                aria-hidden
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro',
                  item.done === true
                    ? 'bg-terminal-long/20 text-terminal-long'
                    : 'border border-terminal-border text-terminal-muted',
                )}
              >
                {item.done === true ? '✓' : ''}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-terminal-text">{t(item.label)}</span>
                <span className="block truncate text-caption text-terminal-muted">
                  {item.done === undefined
                    ? '…'
                    : item.done
                      ? t('dash.check.done')
                      : item.note || t('dash.check.todo')}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Box>
  );
}

function Wallets() {
  const t = useT();
  const wallets = useWallets();
  const list = wallets.data?.wallets ?? [];
  return (
    <Box title={t('nav.wallet')} href="/wallet" link={t('dash.manage')}>
      {wallets.isError ? (
        <p className="px-4 py-3 text-caption text-terminal-short">{t('dash.unavailable')}</p>
      ) : wallets.isPending ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">{t('dash.noWallets')}</p>
      ) : (
        <ul className="divide-y divide-terminal-border/60">
          {list.map((wallet) => (
            <li key={wallet.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-terminal-muted">{wallet.currency}</span>
              <span className="numeric text-terminal-text">
                {money(wallet.balance, wallet.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function OpenPositions({
  state,
  failed,
}: {
  state: AccountStateResponse | undefined;
  failed: boolean;
}) {
  const t = useT();
  const positions = state?.positions ?? [];
  return (
    <Box
      title={t('dash.open', { count: state?.openPositions ?? 0 })}
      href="/terminal"
      link={t('dash.openTerminal')}
      testId="dashboard-positions"
    >
      {failed ? (
        <p className="px-4 py-3 text-caption text-terminal-short">{t('dash.unavailable')}</p>
      ) : state === undefined ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : positions.length === 0 ? (
        <p className="px-4 py-6 text-center text-caption text-terminal-muted">
          {t('empty.positions')}
        </p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-caption">
            <thead className="text-terminal-muted">
              <tr>
                <th className="px-4 py-2 text-start font-normal">{t('col.symbol')}</th>
                <th className="px-2 py-2 text-start font-normal">{t('col.side')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.volume')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.entry')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.current')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('account.floating')}</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((row) => (
                <tr key={row.positionId} className="border-t border-terminal-border/60">
                  <td className="px-4 py-2 text-terminal-text" dir="ltr">
                    {row.symbol}
                  </td>
                  <td className="px-2 py-2">
                    <SideBadge side={row.side} />
                  </td>
                  <td className="numeric px-2 py-2 text-end">{row.volume}</td>
                  <td className="numeric px-2 py-2 text-end">{row.entryPrice}</td>
                  <td className="numeric px-2 py-2 text-end">{row.currentPrice ?? '—'}</td>
                  <td
                    className={cn('numeric px-4 py-2 text-end', toneClass[toneOf(row.netPnl)])}
                    dir="ltr"
                  >
                    {signedMoney(row.netPnl, state.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

function Performance({ accountId }: { accountId: string | null }) {
  const t = useT();
  const perf = usePerformance(accountId, '3M');
  const data = perf.data;
  const months = (data?.months ?? []).slice(-6);
  // Bar lengths only — the figures printed beside them are the server's.
  const widest = Math.max(1, ...months.map((m) => Math.abs(Number(m.netPnl)) || 0));
  const wins = data === undefined ? 0 : data.trades.buys.profitable + data.trades.sells.profitable;
  return (
    <Box
      title={t('dash.perf.title')}
      href="/analytics"
      link={t('dash.perf.more')}
      testId="dashboard-performance"
    >
      {perf.isError ? (
        <p className="px-4 py-3 text-caption text-terminal-short">{t('perf.error')}</p>
      ) : data === undefined ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">
          {accountId === null ? '' : t('perf.loading')}
        </p>
      ) : (
        <div className="space-y-4 p-4">
          <dl className="grid grid-cols-2 gap-3 text-caption sm:grid-cols-4">
            <Mini
              label={t('perf.netResult')}
              value={signedMoney(data.netPnl, data.currency)}
              tone={toneClass[toneOf(data.netPnl)]}
            />
            <Mini
              label={t('perf.return')}
              value={data.returnPercent === null ? '—' : `${data.returnPercent}%`}
            />
            <Mini
              label={t('dash.perf.winRate')}
              value={
                data.trades.total === 0
                  ? '—'
                  : `${Math.round((wins * 100) / data.trades.total)}% (${wins}/${data.trades.total})`
              }
            />
            <Mini label={t('perf.profitFactor')} value={data.profitFactor ?? '—'} />
          </dl>
          {months.length === 0 ? (
            <p className="text-center text-caption text-terminal-muted">{t('perf.empty')}</p>
          ) : (
            <ul className="space-y-2" aria-label={t('perf.byMonth')}>
              {months.map((month) => {
                const size = (Math.abs(Number(month.netPnl)) / widest) * 100;
                const loss = month.netPnl.startsWith('-');
                return (
                  <li
                    key={month.month}
                    className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-caption"
                  >
                    <span className="numeric text-terminal-muted" dir="ltr">
                      {month.month}
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-terminal-raised">
                      <span
                        className={cn(
                          'block h-full rounded-full',
                          loss ? 'bg-terminal-short' : 'bg-terminal-long',
                        )}
                        style={{ width: `${Math.max(2, size)}%` }}
                      />
                    </span>
                    <span className={cn('numeric', toneClass[toneOf(month.netPnl)])} dir="ltr">
                      {signedMoney(month.netPnl, data.currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Box>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-terminal-muted">{label}</dt>
      <dd className={cn('numeric mt-0.5 text-sm', tone ?? 'text-terminal-text')} dir="ltr">
        {value}
      </dd>
    </div>
  );
}

function RecentTrades({ accountId, currency }: { accountId: string | null; currency: string }) {
  const t = useT();
  const trades = useTrades(accountId);
  const recent = [...(trades.data ?? [])]
    .sort((a, b) => Date.parse(b.exitTime) - Date.parse(a.exitTime))
    .slice(0, 6);
  return (
    <Box
      title={t('dash.trades')}
      href="/history"
      link={t('dash.allHistory')}
      testId="dashboard-trades"
    >
      {trades.isError ? (
        <p className="px-4 py-3 text-caption text-terminal-short">{t('dash.unavailable')}</p>
      ) : trades.isPending && accountId !== null ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : recent.length === 0 ? (
        <p className="px-4 py-6 text-center text-caption text-terminal-muted">
          {t('empty.trades')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-caption">
            <thead className="text-terminal-muted">
              <tr>
                <th className="px-4 py-2 text-start font-normal">{t('col.symbol')}</th>
                <th className="px-2 py-2 text-start font-normal">{t('col.side')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.volume')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.exit')}</th>
                <th className="px-2 py-2 text-end font-normal">{t('col.timeUtc')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('perf.netResult')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((trade) => (
                <tr key={trade.id} className="border-t border-terminal-border/60">
                  <td className="px-4 py-2 text-terminal-text" dir="ltr">
                    {trade.symbol}
                  </td>
                  <td className="px-2 py-2">
                    <SideBadge side={trade.side} />
                  </td>
                  <td className="numeric px-2 py-2 text-end">{trade.volume}</td>
                  <td className="numeric px-2 py-2 text-end">{trade.exitPrice}</td>
                  <td className="numeric px-2 py-2 text-end text-terminal-muted">
                    {utcTime(trade.exitTime).slice(0, 16)}
                  </td>
                  <td
                    className={cn('numeric px-4 py-2 text-end', toneClass[toneOf(trade.netPnl)])}
                    dir="ltr"
                  >
                    {signedMoney(trade.netPnl, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

function RecentNotices() {
  const t = useT();
  const notices = useNotifications();
  const items = (notices.data ?? []).slice(0, 5);
  return (
    <Box title={t('dash.notices')} testId="dashboard-notices">
      {notices.isError ? (
        <p className="px-4 py-3 text-caption text-terminal-short">{t('dash.unavailable')}</p>
      ) : notices.isPending ? (
        <p className="px-4 py-3 text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-caption text-terminal-muted">
          {t('dash.noNotices')}
        </p>
      ) : (
        <ul className="divide-y divide-terminal-border/60">
          {items.map((item) => (
            <li key={item.id} className="px-4 py-2.5">
              <p
                className={cn(
                  'truncate text-sm',
                  item.readAt === null ? 'text-terminal-text' : 'text-terminal-muted',
                )}
              >
                {item.severity === 'CRITICAL' ? (
                  <span aria-hidden className="me-1 text-terminal-short">
                    ●
                  </span>
                ) : null}
                {item.title}
              </p>
              <p className="numeric mt-0.5 text-micro text-terminal-muted">
                {utcTime(item.createdAt).slice(0, 16)} UTC
              </p>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-xl border px-4 py-3 text-caption',
        tone === 'error'
          ? 'border-terminal-short/40 text-terminal-short'
          : 'border-terminal-border text-terminal-muted',
      )}
    >
      {children}
    </div>
  );
}
