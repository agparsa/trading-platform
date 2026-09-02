'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { RequireSession } from '@/components/shell/require-session';
import { Nav } from '@/components/shell/nav';
import { Panel } from '@/components/primitives';

const SECTIONS = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/people', label: 'People' },
  { href: '/admin/accounts', label: 'Accounts' },
  { href: '/admin/instruments', label: 'Instruments' },
  { href: '/admin/risk', label: 'Risk' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/kyc', label: 'Verification' },
  { href: '/admin/withdrawals', label: 'Withdrawals' },
  { href: '/admin/reconciliation', label: 'Reconciliation' },
  { href: '/admin/roles', label: 'Roles' },
  { href: '/admin/audit', label: 'Audit' },
] as const;

/**
 * The administrative area.
 *
 * Gated on a session, and on nothing else. The role check that matters happens
 * on the server, for every request, from the caller's own role — so a trader who
 * types one of these URLs sees a page whose every panel answers "your role does
 * not include this", which is exactly the truth.
 *
 * Hiding the section from them would be a courtesy, not a control, and building
 * it as though it were one is how a UI check quietly becomes the only check.
 *
 * These were tabs in a single-page console until this phase. They are routes now
 * for one reason: an operator working an incident is sent a link, and "open
 * Administration, click Accounts, search for 41582" is not a link.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();

  return (
    <RequireSession>
      <div className="flex min-h-screen flex-col bg-terminal-bg">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-terminal-border px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight text-terminal-text">
              Administration
            </span>
            <span className="rounded bg-terminal-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-terminal-muted">
              {user?.role ?? '—'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/terminal"
              className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
            >
              Terminal
            </Link>
            <span className="text-[11px] text-terminal-muted">{user?.email ?? ''}</span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="shrink-0 border-b border-terminal-border bg-terminal-surface px-3 py-1.5">
          <Nav items={SECTIONS} />
        </div>

        <main className="min-h-0 flex-1 overflow-auto p-3">
          <Panel className="min-h-full">{children}</Panel>
        </main>
      </div>
    </RequireSession>
  );
}
