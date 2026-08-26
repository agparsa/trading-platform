import { fetchApiLiveness } from '@/lib/api';

/**
 * Build-status page.
 *
 * Kept after the terminal shipped, because "what is actually finished" is a
 * question this project answers honestly. A phase is marked complete when its
 * behaviour is tested and verified end to end, not when its files exist.
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
    state: 'done',
    detail: 'Authentication, users, accounts, balances, settings.',
  },
  {
    id: '3',
    name: 'Market core',
    state: 'done',
    detail: 'Symbols, contract specs, tick stream, candle aggregation.',
  },
  {
    id: '4',
    name: 'Trading core',
    state: 'done',
    detail: 'Orders, executions, positions, close, partial close, modify, reverse.',
  },
  {
    id: '5',
    name: 'Financial engine',
    state: 'done',
    detail: 'P&L, equity, margin, commission, swap, rounding.',
  },
  {
    id: '6',
    name: 'SL/TP engine',
    state: 'done',
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
    state: 'done',
    detail:
      'Watchlist, order ticket, positions with close/partial/modify/reverse, history, live candles.',
  },
  {
    id: '9',
    name: 'Charting',
    state: 'in-progress',
    detail:
      'Datafeed boundary and lightweight-charts rendering are done. TradingView Advanced Charts: adapter written and tested, widget waiting on the licensed bundle.',
  },
  {
    id: '10',
    name: 'Advanced trading UX',
    state: 'in-progress',
    detail:
      'Resting LIMIT and STOP orders are live — placed, fired, expired, cancelled. Account snapshots and the keyboard workflow remain.',
  },
  {
    id: '11',
    name: 'Security hardening',
    state: 'planned',
    detail: 'httpOnly refresh cookies, CSRF, admin audit surface, penetration checklist.',
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
          The trading engine is the product. This page tracks what is finished and verified, and
          what is not.
        </p>
        <a
          href="/"
          className="mt-4 inline-block text-xs text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ← Terminal
        </a>
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
