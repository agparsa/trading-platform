'use client';

import type { ReactNode } from 'react';
import { NavIcon } from '@/components/shell/nav-icons';
import { useT } from '@/lib/use-locale';

/**
 * The frame of every page a person reaches signed out — sign-in, confirming an
 * address, choosing a new password: the mark, the name, one line saying what
 * the page is for, and a card. One frame, so following an emailed link lands
 * somewhere that looks like the place the email came from.
 */
export function AuthCard({ lead, children }: { lead: string; children: ReactNode }) {
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgb(59_130_246/0.12),_transparent_55%)] px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-terminal-accent text-terminal-bg shadow-lg">
            <NavIcon name="terminal" className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-terminal-text">
            {t('shell.brand')}
          </h1>
        </div>
        <p className="mt-1 text-center text-sm text-terminal-muted">{lead}</p>
        <div className="mt-6 space-y-3 rounded-xl border border-terminal-border bg-terminal-surface p-6 shadow-xl">
          {children}
        </div>
      </div>
    </main>
  );
}

/** The card's primary button, as on the sign-in page. */
export const authButtonClass =
  'w-full rounded border border-transparent bg-terminal-accent py-2 text-sm font-medium text-terminal-bg transition-opacity hover:opacity-90 disabled:opacity-50';
