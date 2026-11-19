'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@tp/ui';
import { useSession } from '@/lib/session';
import { NotificationBell } from '@/components/notification-bell';
import { useT } from '@/lib/use-locale';
import { NavIcon } from './nav-icons';
import { TRADER_GROUPS } from './sections';
import { MenuButton, Sidebar } from './sidebar';

/**
 * The frame around everything that is not the terminal.
 *
 * A menu down the side, grouped, and a bar along the top with the page's name,
 * the notices, the language and the person. The terminal keeps its own
 * full-height chrome and is deliberately not wrapped in this: it is a single
 * dense screen where every pixel of vertical space is a row of the order book.
 * It carries the same sections, from `TRADER_SECTIONS`, so nothing is
 * reachable from here that is not reachable from there.
 */
export function AppShell({
  title,
  description,
  children,
  wide = false,
  hideHeading = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  /** The dashboard's grid wants the room; reading pages keep a measure. */
  wide?: boolean;
  /** For a page whose own header says what the page is. */
  hideHeading?: boolean;
}) {
  const { user, signOut } = useSession();
  const t = useT();
  const initial = (user?.email ?? '?').slice(0, 1).toUpperCase();

  return (
    <Sidebar
      brand={
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-terminal-accent text-terminal-bg">
            <NavIcon name="terminal" className="h-[18px] w-[18px]" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-terminal-text">
            {t('shell.brand')}
          </span>
        </Link>
      }
      groups={TRADER_GROUPS}
      footer={
        <div className="space-y-2">
          {user !== null && user.role !== 'USER' ? (
            <Link
              href="/admin"
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-terminal-muted hover:bg-terminal-raised hover:text-terminal-text"
            >
              <NavIcon name="admin" />
              {t('shell.administration')}
            </Link>
          ) : null}
          <div className="flex items-center gap-2.5 px-2">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-terminal-raised text-xs font-semibold text-terminal-text"
            >
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-caption text-terminal-muted">
              {user?.email ?? ''}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              title={t('shell.signOut')}
              aria-label={t('shell.signOut')}
              className="rounded p-1 text-terminal-muted hover:text-terminal-short"
            >
              <NavIcon name="logout" />
            </button>
          </div>
        </div>
      }
    >
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-terminal-border bg-terminal-bg/90 px-4 backdrop-blur">
        <MenuButton />
        <div className="min-w-0 flex-1">
          {hideHeading ? null : (
            <p className="truncate text-sm font-semibold text-terminal-text lg:hidden">{title}</p>
          )}
        </div>
        <NotificationBell />
        <Link
          href="/terminal"
          className="hidden rounded-md bg-terminal-accent px-3 py-1.5 text-caption font-medium text-terminal-bg hover:opacity-90 sm:inline-flex"
        >
          {t('nav.terminal')}
        </Link>
      </header>

      <main
        className={cn('mx-auto w-full flex-1 px-4 py-6 sm:px-6', wide ? 'max-w-7xl' : 'max-w-5xl')}
      >
        {hideHeading ? null : (
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight text-terminal-text">{title}</h1>
            {description === undefined ? null : (
              <p className="mt-1 max-w-3xl text-sm text-terminal-muted">{description}</p>
            )}
          </div>
        )}
        {children}
      </main>
    </Sidebar>
  );
}
