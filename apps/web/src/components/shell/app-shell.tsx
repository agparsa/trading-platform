'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { Button } from '@/components/primitives';
import { NotificationBell } from '@/components/notification-bell';
import { Nav } from './nav';

const SECTIONS = [
  { href: '/terminal', label: 'Terminal' },
  { href: '/account', label: 'Account' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/verification', label: 'Verification' },
  { href: '/history', label: 'History' },
  { href: '/security', label: 'Security' },
  { href: '/developer', label: 'Developer' },
  { href: '/settings', label: 'Settings' },
] as const;

/**
 * The frame around everything that is not the terminal.
 *
 * The terminal keeps its own full-height chrome and is deliberately not wrapped
 * in this: it is a single dense screen where every pixel of vertical space is a
 * row of the order book, and putting a second header above it would cost that
 * space on the one screen that cannot spare it. The link back to it is here
 * instead.
 *
 * The wallet link arrived with the wallet. It was deliberately absent until
 * there was one — §50 says not to build UI for functionality that does not
 * exist, and a page reading "Balance: —" is a promise the platform cannot keep.
 */
export function AppShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { user, signOut } = useSession();

  return (
    <div className="flex min-h-screen flex-col bg-terminal-bg">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-terminal-border px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            href="/terminal"
            className="text-sm font-semibold tracking-tight text-terminal-text"
          >
            Trading Platform
          </Link>
          <Nav items={SECTIONS} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <NotificationBell />
          {user !== null && user.role !== 'USER' ? (
            <Link
              href="/admin"
              className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
            >
              Administration
            </Link>
          ) : null}
          <span className="text-[11px] text-terminal-muted">{user?.email ?? ''}</span>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <div className="mb-5">
          <h1 className="text-base font-semibold tracking-tight text-terminal-text">{title}</h1>
          {description === undefined ? null : (
            <p className="mt-1 text-[11px] text-terminal-muted">{description}</p>
          )}
        </div>
        {children}
      </main>
    </div>
  );
}
