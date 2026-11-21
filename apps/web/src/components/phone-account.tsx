'use client';

import { NavIcon, type NavIconName } from './shell/nav-icons';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@tp/ui';
import { accountView } from '@/lib/account-view';
import { money, percent } from '@/lib/format';
import type { MessageKey } from '@/lib/messages';
import { useAccounts, useProfile, type AccountStateResponse } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/use-locale';
import { ProfileSettings } from './profile-settings';
import { SoundSettings } from './sound-settings';
import { ThemeSettings } from './theme-settings';

/**
 * Account and settings on a phone, laid out the way a trading app's is: who
 * you are, your trading accounts (tap one to trade it), the selected
 * account's figures, money in and out, history, security, and the settings
 * — appearance and sound — then sign out.
 *
 * Every figure is the server's: the profile from `/users/me`, the accounts
 * from `/accounts`, balance through margin level from the account state the
 * terminal already holds, live from the socket. Nothing is shown that the
 * platform does not have — there is no photo on a profile, so there is no
 * field pretending there is.
 */
export function PhoneAccount({
  accountId,
  snapshot,
  onSignOut,
}: {
  accountId: string | null;
  snapshot: AccountStateResponse | undefined;
  onSignOut: () => void;
}) {
  const t = useT();
  const { selectAccount } = useSession();
  const profile = useProfile();
  const [editing, setEditing] = useState(false);
  const accounts = useAccounts();
  const live = useRealtime((state) => state.account);
  const state = accountView(accountId, snapshot, live);
  const selected = (accounts.data ?? []).find((row) => row.id === accountId);
  const name = profile.data?.displayName ?? '';
  const initials =
    name
      .split(/\s+/)
      .filter((part) => part !== '')
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '•';

  return (
    <div
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-6 pt-3"
      data-testid="phone-account"
    >
      {/* Who */}
      <div className="rounded-xl bg-terminal-surface">
        <button
          type="button"
          onClick={() => setEditing((now) => !now)}
          aria-expanded={editing}
          className="flex w-full items-center gap-3 p-3 text-start"
          data-testid="phone-profile"
        >
          <span
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-terminal-raised text-sm font-medium text-terminal-text"
          >
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-terminal-text">
              {profile.isPending ? '…' : name}
            </span>
            <span className="block truncate text-caption text-terminal-muted">
              {profile.data?.email ?? ''}
              {profile.data !== undefined && !profile.data.emailVerified
                ? ` · ${t('more.unverified')}`
                : ''}
            </span>
            {profile.data?.phone == null ? null : (
              <span className="numeric block truncate text-caption text-terminal-muted" dir="ltr">
                {profile.data.phone}
              </span>
            )}
          </span>
          <Chevron />
        </button>
        {editing ? (
          <div className="border-t border-terminal-border px-3 pb-3 pt-2">
            <ProfileSettings />
          </div>
        ) : null}
      </div>

      {/* Trading accounts */}
      <section className="rounded-xl bg-terminal-surface p-1" aria-labelledby="more-accounts">
        <h2
          id="more-accounts"
          className="px-3 pb-1 pt-2 text-label uppercase tracking-wider text-terminal-muted"
        >
          {t('more.accounts')}
        </h2>
        {accounts.isError ? (
          <p className="px-3 py-2 text-caption text-terminal-short">{t('more.accountsFailed')}</p>
        ) : accounts.data === undefined ? (
          <p className="px-3 py-2 text-caption text-terminal-muted">…</p>
        ) : (
          <ul>
            {accounts.data.map((row) => {
              const current = row.id === accountId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => selectAccount(row.id)}
                    aria-pressed={current}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start',
                      current && 'bg-terminal-raised',
                    )}
                    data-testid="phone-account-row"
                  >
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider',
                        row.type === 'LIVE'
                          ? 'bg-terminal-long/15 text-terminal-long'
                          : 'bg-terminal-warning/15 text-terminal-warning',
                      )}
                    >
                      {row.type}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="numeric block text-sm text-terminal-text">
                        #{row.number}
                      </span>
                      <span className="block text-caption text-terminal-muted">
                        {row.currency} · 1:{row.leverage}
                      </span>
                    </span>
                    <span className="numeric text-sm text-terminal-text">
                      {money(row.balance, row.currency)}
                    </span>
                    {current ? (
                      <span aria-hidden className="text-terminal-accent">
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* The selected account's figures */}
      {selected === undefined ? null : (
        <section className="rounded-xl bg-terminal-surface p-3" aria-labelledby="more-figures">
          <h2
            id="more-figures"
            className="mb-2 text-label uppercase tracking-wider text-terminal-muted"
          >
            {t('more.details', { number: selected.number })}
          </h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
            <Figure label="account.balance" value={money(state?.balance, selected.currency)} />
            <Figure label="account.equity" value={money(state?.equity, selected.currency)} />
            <Figure
              label="account.usedMargin"
              value={money(state?.usedMargin, selected.currency)}
            />
            <Figure
              label="account.freeMargin"
              value={money(state?.freeMargin, selected.currency)}
            />
            <Figure
              label="account.marginLevel"
              value={state?.marginLevel == null ? '—' : percent(state.marginLevel)}
            />
            <Figure label="account.leverage" value={`1:${selected.leverage}`} />
            <Figure label="account.type" value={selected.type} />
            <Figure label="account.currency" value={selected.currency} />
          </dl>
        </section>
      )}

      {/* Money and records */}
      <Group>
        <Row href="/wallet" label="more.deposit" icon="deposit" accent />
        <Row href="/wallet" label="more.withdraw" icon="withdrawals" accent />
        <Row href="/history" label="more.history" icon="history" />
        <Row href="/analytics" label="nav.analytics" icon="analytics" />
        <Row href="/instruments" label="nav.instruments" icon="instruments" />
      </Group>

      <Group>
        <Row href="/security" label="more.security" icon="security" />
        <Row href="/verification" label="nav.verification" icon="verification" />
        <Row href="/settings" label="more.tradingSettings" icon="settings" />
      </Group>

      <section className="space-y-4 rounded-xl bg-terminal-surface p-3">
        <ThemeSettings />
        <SoundSettings />
      </section>

      <Group>
        <Row href="/status" label="more.status" icon="help" />
        <Row href="/developer" label="nav.developer" icon="developer" />
      </Group>

      <button
        type="button"
        onClick={onSignOut}
        className="flex w-full items-center gap-3 rounded-xl bg-terminal-surface px-3 py-3 text-sm text-terminal-short"
        data-testid="phone-sign-out"
      >
        <span aria-hidden>⎋</span>
        {t('shell.signOut')}
      </button>
    </div>
  );
}

function Figure({ label, value }: { label: MessageKey; value: string }) {
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-terminal-muted">{t(label)}</dt>
      <dd className="numeric text-terminal-text">{value}</dd>
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-terminal-border/60 overflow-hidden rounded-xl bg-terminal-surface">
      {children}
    </ul>
  );
}

function Row({
  href,
  label,
  icon,
  accent = false,
}: {
  href: string;
  label: MessageKey;
  icon: NavIconName;
  accent?: boolean;
}) {
  const t = useT();
  return (
    <li>
      <Link
        href={href}
        className={cn(
          'flex min-h-12 items-center gap-3 px-3 text-sm',
          accent ? 'text-terminal-accent' : 'text-terminal-text',
        )}
      >
        <span aria-hidden className={accent ? 'text-terminal-accent' : 'text-terminal-muted'}>
          <NavIcon name={icon} className="h-[18px] w-[18px]" />
        </span>
        <span className="flex-1">{t(label)}</span>
        <Chevron />
      </Link>
    </li>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 14 14"
      className="shrink-0 text-terminal-muted rtl:rotate-180"
    >
      <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
