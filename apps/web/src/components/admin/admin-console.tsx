'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@tp/ui';
import { useSession } from '@/lib/session';
import { Panel, Tabs } from '@/components/primitives';
import { OverviewPanel } from './overview-panel';
import { PeoplePanel } from './people-panel';
import { AccountsPanel } from './accounts-panel';
import { RiskPanel } from './risk-panel';
import { AuditPanel } from './audit-panel';
import { ReconciliationPanel } from './reconciliation-panel';

type AdminTab = 'overview' | 'people' | 'accounts' | 'risk' | 'reconciliation' | 'audit';

/**
 * The administrative console.
 *
 * A second area of the same application rather than a second application: the
 * session, the API client, the error envelope and the formatting are all the
 * ones the terminal already uses, and duplicating them would be duplicating the
 * places a security decision has to be made.
 *
 * Nothing here is a permission check. Every panel simply asks the API, and the
 * API decides from the caller's own role on every request — so a support user
 * who reaches this page sees the parts they may see and a refusal on the rest,
 * which is the same answer they would get with the URL typed by hand.
 */
export function AdminConsole() {
  const { user, signOut } = useSession();
  const [tab, setTab] = useState<AdminTab>('overview');

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-terminal-bg">
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
            href="/"
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
        <Tabs<AdminTab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'people', label: 'People' },
            { id: 'accounts', label: 'Accounts' },
            { id: 'risk', label: 'Risk' },
            { id: 'reconciliation', label: 'Reconciliation' },
            { id: 'audit', label: 'Audit' },
          ]}
        />
      </div>

      <main className={cn('min-h-0 flex-1 overflow-auto p-3')}>
        <Panel className="min-h-full">
          {tab === 'overview' ? <OverviewPanel /> : null}
          {tab === 'people' ? <PeoplePanel /> : null}
          {tab === 'accounts' ? <AccountsPanel /> : null}
          {tab === 'risk' ? <RiskPanel /> : null}
          {tab === 'reconciliation' ? <ReconciliationPanel /> : null}
          {tab === 'audit' ? <AuditPanel /> : null}
        </Panel>
      </main>
    </div>
  );
}
