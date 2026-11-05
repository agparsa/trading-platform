'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { signedMoney, toneClass, toneOf } from '@/lib/format';
import { usePerformance, type PerformanceRow } from '@/lib/queries';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';
import { EmptyState, Panel } from './primitives';

const PERIODS: ReadonlyArray<{ id: PerformanceRow['period']; label: MessageKey }> = [
  { id: '3M', label: 'perf.period.3M' },
  { id: '1Y', label: 'perf.period.1Y' },
  { id: 'ALL', label: 'perf.period.ALL' },
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
  label: MessageKey;
  profitable: number;
  losing: number;
  total: number;
}) {
  const t = useT();
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-caption text-terminal-muted">
        <span>{t(label, { total, profitable, losing })}</span>
        <span className="numeric">{t('perf.won', { share: share(profitable, total) })}</span>
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
  const t = useT();

  return (
    <div className="space-y-3" data-testid="performance">
      <div role="radiogroup" aria-label={t('perf.period')} className="flex gap-1">
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
            {t(option.label)}
          </button>
        ))}
      </div>

      {accountId === null ? (
        <EmptyState>{t('empty.noAccount')}</EmptyState>
      ) : result.isError ? (
        <EmptyState>{t('perf.error')}</EmptyState>
      ) : data === undefined ? (
        <EmptyState>{t('perf.loading')}</EmptyState>
      ) : data.trades.total === 0 ? (
        <EmptyState>{t('perf.empty')}</EmptyState>
      ) : (
        <>
          <Panel className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
            <Figure
              label={t('perf.netResult')}
              value={signedMoney(data.netPnl, data.currency)}
              tone={data.netPnl}
            />
            <Figure
              label={t('perf.return')}
              value={percent(data.returnPercent)}
              tone={data.returnPercent}
            />
            <Figure label={t('perf.trades')} value={String(data.trades.total)} />
            <Figure label={t('perf.profitFactor')} value={data.profitFactor ?? '—'} />
            <Figure
              label={t('perf.averageWin')}
              value={data.averageWin === null ? '—' : signedMoney(data.averageWin, data.currency)}
              tone={data.averageWin}
            />
            <Figure
              label={t('perf.averageLoss')}
              value={data.averageLoss === null ? '—' : signedMoney(data.averageLoss, data.currency)}
              tone={data.averageLoss}
            />
            <Figure
              label={t('perf.grossProfit')}
              value={signedMoney(data.grossProfit, data.currency)}
              tone={data.grossProfit}
            />
            <Figure
              label={t('perf.grossLoss')}
              value={signedMoney(data.grossLoss, data.currency)}
              tone={data.grossLoss}
            />
          </Panel>
          {data.returnPercent === null || data.profitFactor === null ? (
            <p className="text-caption text-terminal-muted">
              {data.returnPercent === null ? `${t('perf.noReturn')} ` : ''}
              {data.profitFactor === null ? t('perf.noProfitFactor') : ''}
            </p>
          ) : null}

          <Panel className="space-y-3 p-4">
            <h2 className="text-label uppercase tracking-wider text-terminal-muted">
              {t('perf.bySide')}
            </h2>
            <Split label="perf.split.buys" {...data.trades.buys} />
            <Split label="perf.split.sells" {...data.trades.sells} />
            <h2 className="pt-2 text-label uppercase tracking-wider text-terminal-muted">
              {t('perf.byDay', { zone: data.timeZone })}
            </h2>
            <Split label="perf.split.days" {...data.days} />
          </Panel>

          <Panel className="p-4">
            <h2 className="mb-2 text-label uppercase tracking-wider text-terminal-muted">
              {t('perf.byMonth')}
            </h2>
            <table className="w-full border-collapse text-xs" data-testid="performance-months">
              <thead>
                <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
                  <th className="py-1 pe-2 font-medium">{t('perf.month')}</th>
                  <th className="px-2 py-1 text-end font-medium">{t('perf.trades')}</th>
                  <th className="py-1 ps-2 text-end font-medium">{t('perf.netResult')}</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((row) => (
                  <tr key={row.month} className="border-t border-terminal-border/60">
                    <td className="numeric py-1.5 pe-2 text-terminal-text">{row.month}</td>
                    <td className="numeric px-2 py-1.5 text-end text-terminal-muted">
                      {row.trades}
                    </td>
                    <td
                      className={cn('numeric py-1.5 ps-2 text-end', toneClass[toneOf(row.netPnl)])}
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
