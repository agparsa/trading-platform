'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { curveGeometry } from '@/lib/curve-path';
import { money } from '@/lib/format';
import { useEquityCurve, type EquityCurvePeriod } from '@/lib/queries';
import { useT } from '@/lib/use-locale';

const PERIODS: readonly EquityCurvePeriod[] = ['1W', '1M', '3M'];
const W = 640;
const H = 200;

/**
 * Balance and equity by trading day, from the platform's snapshots.
 *
 * The lines are drawn from the server's points; every number written beside
 * them — peak, worst drawdown, the hovered day's figures — is the server's
 * own string. A day with nothing recorded is not drawn, and a period with
 * nothing recorded says so rather than drawing a flat line at zero.
 */
export function EquityChart({ accountId }: { accountId: string | null }) {
  const t = useT();
  const [period, setPeriod] = useState<EquityCurvePeriod>('1M');
  const [hover, setHover] = useState<number | null>(null);
  const curve = useEquityCurve(accountId, period);
  const data = curve.data;
  const points = data?.points ?? [];
  const geometry = curveGeometry(
    [points.map((p) => p.equity), points.map((p) => p.balance)],
    W,
    H,
    8,
  );
  const shown = hover === null ? points.at(-1) : points[hover];

  return (
    <section
      className="flex flex-col rounded-xl border border-terminal-border bg-terminal-surface"
      aria-labelledby="dash-curve"
      data-testid="dashboard-equity"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-4 py-3">
        <div>
          <h2 id="dash-curve" className="text-sm font-semibold text-terminal-text">
            {t('dash.curve.title')}
          </h2>
          <p className="mt-0.5 text-caption text-terminal-muted">{t('dash.curve.lead')}</p>
        </div>
        <div className="flex gap-1" role="group" aria-label={t('perf.period')}>
          {PERIODS.map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => {
                setPeriod(one);
                setHover(null);
              }}
              aria-pressed={period === one}
              className={cn(
                'rounded px-2 py-1 text-caption',
                period === one
                  ? 'bg-terminal-raised text-terminal-text'
                  : 'text-terminal-muted hover:text-terminal-text',
              )}
            >
              {t(`dash.curve.${one}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 px-4 py-3">
        {curve.isPending && accountId !== null ? (
          <p className="py-16 text-center text-caption text-terminal-muted">
            {t('common.loading')}
          </p>
        ) : curve.isError ? (
          <p className="py-16 text-center text-caption text-terminal-short">
            {t('dash.curve.error')}
          </p>
        ) : geometry === null || data === undefined ? (
          <p className="py-16 text-center text-caption text-terminal-muted">
            {t('dash.curve.empty')}
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-caption">
              <span className="text-terminal-muted">
                <span className="numeric" dir="ltr">
                  {shown?.day}
                </span>
                {' · '}
                <span className="text-terminal-accent">{t('account.equity')}</span>{' '}
                <span className="numeric text-terminal-text">
                  {money(shown?.equity, data.currency)}
                </span>
                {' · '}
                {t('account.balance')}{' '}
                <span className="numeric text-terminal-text">
                  {money(shown?.balance, data.currency)}
                </span>
              </span>
              <span className="text-terminal-muted">
                {t('dash.curve.zone', { zone: data.timeZone })}
              </span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-52 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={t('dash.curve.title')}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                <linearGradient id="dash-eq-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <g className="text-terminal-accent">
                <path d={geometry.area} fill="url(#dash-eq-fill)" />
              </g>
              <path
                d={geometry.lines[1]}
                fill="none"
                strokeDasharray="4 4"
                className="stroke-terminal-muted"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={geometry.lines[0]}
                fill="none"
                className="stroke-terminal-accent"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {hover === null ? null : (
                <line
                  x1={geometry.xs[hover]}
                  x2={geometry.xs[hover]}
                  y1={0}
                  y2={H}
                  className="stroke-terminal-border"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {geometry.xs.map((x, i) => {
                const prev = geometry.xs[i - 1];
                const next = geometry.xs[i + 1];
                const left = prev === undefined ? 0 : (prev + x) / 2;
                const right = next === undefined ? W : (x + next) / 2;
                return (
                  <rect
                    key={points[i]?.day ?? i}
                    x={left}
                    y={0}
                    width={Math.max(1, right - left)}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                  />
                );
              })}
            </svg>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-caption sm:grid-cols-4">
              <Stat label={t('dash.curve.peak')} value={money(data.peakEquity, data.currency)} />
              <Stat
                label={t('dash.curve.maxDrawdown')}
                value={money(data.maxDrawdown, data.currency)}
                tone={data.maxDrawdown === '0' ? undefined : 'text-terminal-short'}
              />
              <Stat
                label={t('dash.curve.maxDrawdownPct')}
                value={data.maxDrawdownPercent === null ? '—' : `${data.maxDrawdownPercent}%`}
              />
              <Stat label={t('dash.curve.days')} value={String(points.length)} />
            </dl>
            <p className="mt-2 flex gap-4 text-micro text-terminal-muted">
              <span className="flex items-center gap-1">
                <span aria-hidden className="inline-block h-0.5 w-4 bg-terminal-accent" />
                {t('account.equity')}
              </span>
              <span className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block w-4 border-t border-dashed border-terminal-muted"
                />
                {t('account.balance')}
              </span>
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <div>
      <dt className="text-terminal-muted">{label}</dt>
      <dd className={cn('numeric mt-0.5 text-sm', tone ?? 'text-terminal-text')}>{value}</dd>
    </div>
  );
}
