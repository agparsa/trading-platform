'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { signedMoney, toneClass, toneOf } from '@/lib/format';
import { usePerformance, type PerformanceRow } from '@/lib/queries';
import { EmptyState, Panel } from './primitives';

const PERIODS: ReadonlyArray<{ id: PerformanceRow['period']; label: string }> = [
  { id: '3M', label: '3 months' },
  { id: '1Y', label: '1 year' },
  { id: 'ALL', label: 'All' },
];

/** `12.50` → `+12.50%`; null stays a dash with its reason beside it. */
function percent(value: string | null): string {
  if (value === null) return '—';
  return `${value.startsWith('-') ? '' : '+'}${value}%`;
}

function share(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string | null }) {
  return (
    <div>
      <div className="text-label uppercase tracking-wider text-terminal-muted">{label}</div>
      <div
        className={cn(
          'numeric text-base text-terminal-text',
          tone ? toneClass[toneOf(tone)] : null,
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Split({
  label,
  profitable,
  losing,
  total,
}: {
  label: string;
  profitable: number;
  losing: number;
  total: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-caption text-terminal-muted">
        <span>
          {total} {label} · {profitable} profitable · {losing} losing
        </span>
        <span className="numeric">{share(profitable, total)} won</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded bg-terminal-raised" aria-hidden>
        <div className="bg-terminal-long" style={{ width: share(profitable, total) }} />
        <div className="bg-terminal-short" style={{ width: share(losing, total) }} />
      </div>
    </div>
  );
}

/**
 * The account's performance over a chosen period. Every figure is the
 * server's (`GET /accounts/:id/performance`); this only lays them out. A
 * figure that cannot honestly be given — a profit factor with no losing
 * trade, a return with no balance to measure it against — is a dash with
 * the reason, never a zero.
 */
export function PerformanceView({ accountId }: { accountId: string | null }) {
  const [period, setPeriod] = useState<PerformanceRow['period']>('3M');
  const result = usePerformance(accountId, period);
  const data = result.data;

  return (
    <div className="space-y-3" data-testid="performance">
      <div role="radiogroup" aria-label="Period" className="flex gap-1">
        {PERIODS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={period === option.id}
            onClick={() => setPeriod(option.id)}
            className={cn(
              'rounded border px-3 py-1 text-xs',
              period === option.id
                ? 'border-terminal-accent text-terminal-text'
                : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {accountId === null ? (
        <EmptyState>No account selected.</EmptyState>
      ) : result.isError ? (
        <EmptyState>The figures could not be loaded. They will retry.</EmptyState>
      ) : data === undefined ? (
        <EmptyState>Working out the figures…</EmptyState>
      ) : data.trades.total === 0 ? (
        <EmptyState>No trades closed in this period.</EmptyState>
      ) : (
        <>
          <Panel className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
            <Figure
              label="Net result"
              value={signedMoney(data.netPnl, data.currency)}
              tone={data.netPnl}
            />
            <Figure label="Return" value={percent(data.returnPercent)} tone={data.returnPercent} />
            <Figure label="Trades" value={String(data.trades.total)} />
            <Figure label="Profit factor" value={data.profitFactor ?? '—'} />
            <Figure
              label="Average win"
              value={data.averageWin === null ? '—' : signedMoney(data.averageWin, data.currency)}
              tone={data.averageWin}
            />
            <Figure
              label="Average loss"
              value={data.averageLoss === null ? '—' : signedMoney(data.averageLoss, data.currency)}
              tone={data.averageLoss}
            />
            <Figure
              label="Gross profit"
              value={signedMoney(data.grossProfit, data.currency)}
              tone={data.grossProfit}
            />
            <Figure
              label="Gross loss"
              value={signedMoney(data.grossLoss, data.currency)}
              tone={data.grossLoss}
            />
          </Panel>
          {data.returnPercent === null || data.profitFactor === null ? (
            <p className="text-caption text-terminal-muted">
              {data.returnPercent === null
                ? 'No return is given: the account had no balance before this period began. '
                : ''}
              {data.profitFactor === null
                ? 'No profit factor: no trade in this period lost money.'
                : ''}
            </p>
          ) : null}

          <Panel className="space-y-3 p-4">
            <h2 className="text-label uppercase tracking-wider text-terminal-muted">By side</h2>
            <Split label="buys" {...data.trades.buys} />
            <Split label="sells" {...data.trades.sells} />
            <h2 className="pt-2 text-label uppercase tracking-wider text-terminal-muted">
              By day ({data.timeZone})
            </h2>
            <Split label="trading days" {...data.days} />
          </Panel>

          <Panel className="p-4">
            <h2 className="mb-2 text-label uppercase tracking-wider text-terminal-muted">
              By month
            </h2>
            <table className="w-full border-collapse text-xs" data-testid="performance-months">
              <thead>
                <tr className="text-left text-label uppercase tracking-wider text-terminal-muted">
                  <th className="py-1 pr-2 font-medium">Month</th>
                  <th className="px-2 py-1 text-right font-medium">Trades</th>
                  <th className="py-1 pl-2 text-right font-medium">Net result</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((row) => (
                  <tr key={row.month} className="border-t border-terminal-border/60">
                    <td className="numeric py-1.5 pr-2 text-terminal-text">{row.month}</td>
                    <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                      {row.trades}
                    </td>
                    <td
                      className={cn(
                        'numeric py-1.5 pl-2 text-right',
                        toneClass[toneOf(row.netPnl)],
                      )}
                      title={row.netPnl}
                    >
                      {signedMoney(row.netPnl, data.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
