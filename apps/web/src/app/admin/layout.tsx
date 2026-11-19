'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { RequireSession } from '@/components/shell/require-session';
import { NavIcon } from '@/components/shell/nav-icons';
import { MenuButton, Sidebar, type SidebarGroup } from '@/components/shell/sidebar';
import { Panel } from '@/components/primitives';

/**
 * Every admin section, grouped by what an operator is doing: looking after
 * people, watching the book, moving money, running the platform, keeping it
 * safe. Two rows of twenty-three words was every screen at once.
 */
const GROUPS: readonly SidebarGroup[] = [
  { items: [{ href: '/admin/overview', label: 'Overview', icon: 'dashboard' }] },
  {
    title: 'Customers',
    items: [
      { href: '/admin/people', label: 'People', icon: 'people' },
      { href: '/admin/accounts', label: 'Accounts', icon: 'account' },
      { href: '/admin/kyc', label: 'Verification', icon: 'verification' },
    ],
  },
  {
    title: 'Trading',
    items: [
      { href: '/admin/book', label: 'Book', icon: 'book' },
      { href: '/admin/instruments', label: 'Instruments', icon: 'instruments' },
      { href: '/admin/market-data', label: 'Market data', icon: 'market' },
      { href: '/admin/risk', label: 'Risk', icon: 'risk' },
      { href: '/admin/desks', label: 'Desks', icon: 'desks' },
    ],
  },
  {
    title: 'Money',
    items: [
      { href: '/admin/payments', label: 'Payments', icon: 'payments' },
      { href: '/admin/withdrawals', label: 'Withdrawals', icon: 'withdrawals' },
      { href: '/admin/reconciliation', label: 'Reconciliation', icon: 'reconciliation' },
      { href: '/admin/reports', label: 'Reports', icon: 'reports' },
    ],
  },
  {
    title: 'Platform',
    items: [
      { href: '/admin/brokers', label: 'Brokers', icon: 'brokers' },
      { href: '/admin/connections', label: 'Connections', icon: 'connections' },
      { href: '/admin/credentials', label: 'Credentials', icon: 'credentials' },
      { href: '/admin/features', label: 'Features', icon: 'features' },
      { href: '/admin/notifications', label: 'Notifications', icon: 'notifications' },
      { href: '/admin/webhooks', label: 'Webhooks', icon: 'webhooks' },
    ],
  },
  {
    title: 'Access & audit',
    items: [
      { href: '/admin/roles', label: 'Roles', icon: 'roles' },
      { href: '/admin/security', label: 'Security', icon: 'security' },
      { href: '/admin/audit', label: 'Audit', icon: 'audit' },
    ],
  },
];

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
      <Sidebar
        brand={
          <Link href="/admin/overview" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-terminal-warning text-terminal-bg">
              <NavIcon name="admin" className="h-[18px] w-[18px]" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-terminal-text">
              Administration
            </span>
          </Link>
        }
        groups={GROUPS}
        footer={
          <div className="space-y-2">
            <Link
              href="/terminal"
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-terminal-muted hover:bg-terminal-raised hover:text-terminal-text"
            >
              <NavIcon name="terminal" />
              Terminal
            </Link>
            <div className="flex items-center gap-2.5 px-2">
              <span className="rounded bg-terminal-raised px-1.5 py-0.5 text-micro uppercase tracking-wider text-terminal-muted">
                {user?.role ?? '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-caption text-terminal-muted">
                {user?.email ?? ''}
              </span>
              <button
                type="button"
                onClick={() => void signOut()}
                title="Sign out"
                aria-label="Sign out"
                className="rounded p-1 text-terminal-muted hover:text-terminal-short"
              >
                <NavIcon name="logout" />
              </button>
            </div>
          </div>
        }
      >
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-terminal-border bg-terminal-bg/90 px-3 backdrop-blur lg:hidden">
          <MenuButton />
          <span className="text-sm font-semibold text-terminal-text">Administration</span>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-3 lg:p-4">
          <Panel className="min-h-full">{children}</Panel>
        </main>
      </Sidebar>
    </RequireSession>
  );
}
