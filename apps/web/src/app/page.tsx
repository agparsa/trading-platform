import { fetchApiLiveness } from '@/lib/api';

/**
 * Build-status page.
 *
 * Deliberately not a mocked-up terminal. The trading terminal arrives in
 * Phase 8, once orders, positions, P&L and the realtime feed are real; showing
 * invented balances before then would misrepresent what works.
 */

interface Phase {
  readonly id: string;
  readonly name: string;
  readonly state: 'done' | 'in-progress' | 'planned';
  readonly detail: string;
}

const PHASES: readonly Phase[] = [
  {
    id: '0',
    name: 'Product definition',
    state: 'done',
    detail:
      'Architecture, domain model, ERD, state machines, financial formulas, API and WebSocket contracts.',
  },
  {
    id: '1',
    name: 'Project foundation',
    state: 'done',
    detail: 'Monorepo, strict TypeScript, Docker, PostgreSQL, Redis, NestJS, Next.js, CI.',
  },
  {
    id: '2',
    name: 'Account system',
    state: 'planned',
    detail: 'Authentication, users, accounts, balances, settings.',
  },
  {
    id: '3',
    name: 'Market core',
    state: 'planned',
    detail: 'Symbols, contract specs, tick stream, candle aggregation.',
  },
  {
    id: '4',
    name: 'Trading core',
    state: 'planned',
    detail: 'Orders, executions, positions, close, partial close, modify, reverse.',
  },
  {
    id: '5',
    name: 'Financial engine',
    state: 'planned',
    detail: 'P&L, equity, margin, commission, swap, rounding.',
  },
  {
    id: '6',
    name: 'SL/TP engine',
    state: 'planned',
    detail: 'Server-side triggers with race protection.',
  },
  {
    id: '7',
    name: 'Realtime',
    state: 'done',
    detail:
      'WebSocket gateway with sequenced frames, account-scoped channels, Redis fan-out and tick-driven P&L.',
  },
  {
    id: '8',
    name: 'Trading terminal',
    state: 'in-progress',
    detail: 'Layout, chart, watchlist, order ticket, positions, history.',
  },
];

const STATE_LABEL: Record<Phase['state'], string> = {
  done: 'Complete',
  'in-progress': 'In progress',
  planned: 'Planned',
};

const STATE_CLASS: Record<Phase['state'], string> = {
  done: 'text-terminal-long border-terminal-long/40 bg-terminal-long/10',
  'in-progress': 'text-terminal-warning border-terminal-warning/40 bg-terminal-warning/10',
  planned: 'text-terminal-muted border-terminal-border bg-terminal-raised',
};

export default async function StatusPage() {
  const liveness = await fetchApiLiveness();

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="border-b border-terminal-border pb-8">
        <p className="numeric text-xs uppercase tracking-[0.2em] text-terminal-muted">
          Trading Platform
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-terminal-text">Build status</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-terminal-muted">
          The trading engine is the product; this page is scaffolding. It will be replaced by the
          terminal in Phase 8, once orders, positions and P&amp;L are real rather than illustrated.
        </p>
      </header>

      <section className="mt-8 rounded-lg border border-terminal-border bg-terminal-surface p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-terminal-text">API</h2>
            <p className="numeric mt-1 text-xs text-terminal-muted">
              {liveness === null
                ? 'Not reachable from the web process'
                : `up · ${liveness.uptimeSeconds}s`}
            </p>
          </div>
          <span
            className={`numeric rounded border px-2.5 py-1 text-xs ${
              liveness === null
                ? 'border-terminal-short/40 bg-terminal-short/10 text-terminal-short'
                : 'border-terminal-long/40 bg-terminal-long/10 text-terminal-long'
            }`}
          >
            {liveness === null ? 'DOWN' : 'OK'}
          </span>
        </div>
      </section>

      <ol className="mt-8 space-y-2">
        {PHASES.map((phase) => (
          <li
            key={phase.id}
            className="flex items-start gap-4 rounded-lg border border-terminal-border bg-terminal-surface px-5 py-4"
          >
            <span className="numeric mt-0.5 w-6 shrink-0 text-xs text-terminal-muted">
              {phase.id}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-terminal-text">{phase.name}</p>
              <p className="mt-1 text-xs leading-relaxed text-terminal-muted">{phase.detail}</p>
            </div>
            <span
              className={`numeric shrink-0 rounded border px-2.5 py-1 text-[11px] ${STATE_CLASS[phase.state]}`}
            >
              {STATE_LABEL[phase.state]}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
