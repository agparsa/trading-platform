'use client';

import Link from 'next/link';
import { feedTrouble } from '@/lib/feed-trouble';
import { isTradingHalted } from '@tp/shared-types';
import { cn } from '@tp/ui';
import { Stat } from '@/components/primitives';
import {
  useMarketData,
  useRaisedAlerts,
  useHaltTrading,
  useOperationsSummary,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

/**
 * Is the platform all right?
 *
 * A small number of counts, deliberately. A dashboard with sixty figures on it
 * is a dashboard nobody reads, and the point of this one is that a person
 * glancing at it can tell within a second whether anything needs them. Anything
 * that does have somewhere to go and look further.
 */
export function OverviewPanel() {
  const summary = useOperationsSummary();
  const halt = useHaltTrading();
  const alerts = useRaisedAlerts('open');
  const market = useMarketData();
  const trouble = feedTrouble(market.data?.providers ?? []);

  if (summary.isLoading) return <Loading>Reading the platform…</Loading>;
  if (summary.error !== null) return <ErrorLine error={summary.error} />;

  const data = summary.data;
  if (data === undefined) return <Loading>Nothing to show yet.</Loading>;

  const halted = isTradingHalted(data.trading);

  return (
    <div className="flex flex-col gap-4 p-3">
      {trouble.map((source) => (
        <Link
          key={source.name}
          href="/admin/market-data"
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-terminal-short/50 bg-terminal-short/10 px-3 py-2 text-caption text-terminal-text transition-colors hover:bg-terminal-short/15"
          data-testid="overview-feed-trouble"
        >
          <span>
            <span className="font-semibold text-terminal-short">
              Prices from {source.name} are not arriving
            </span>
            {source.error === null ? '' : ` — ${source.error}`}. {source.symbols.join(', ')} cannot
            be traded until they return.
          </span>
          <span className="text-terminal-muted">Open Market data →</span>
        </Link>
      ))}
      {(alerts.data?.open ?? 0) === 0 ? null : (
        <Link
          href="/admin/alerts"
          className="flex items-center justify-between gap-3 rounded border border-terminal-warning/50 bg-terminal-warning/10 px-3 py-2 text-caption text-terminal-text transition-colors hover:bg-terminal-warning/15"
          data-testid="overview-alerts"
        >
          <span>
            <span className="numeric font-semibold text-terminal-warning">{alerts.data?.open}</span>{' '}
            alert{alerts.data?.open === 1 ? '' : 's'} raised and not yet acknowledged.
          </span>
          <span className="text-terminal-muted">Open Alerts →</span>
        </Link>
      )}
      {/*
        The kill switch first, because during the incident where it matters
        nobody scrolls. Halting stops new risk; closing stays available, which
        is the whole reason it is a halt and not a shutdown.
      */}
      <section
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2',
          halted
            ? 'border-terminal-short/50 bg-terminal-short/10'
            : 'border-terminal-border bg-terminal-raised/30',
        )}
      >
        <div>
          <p className="text-label uppercase tracking-wider text-terminal-muted">Trading</p>
          <p
            className={cn(
              'mt-0.5 text-sm font-medium',
              halted ? 'text-terminal-short' : 'text-terminal-long',
            )}
          >
            {halted ? 'Halted' : 'Open'}
          </p>
          {halted && data.trading.reason != null ? (
            <p className="mt-0.5 text-caption text-terminal-muted">{data.trading.reason}</p>
          ) : null}
        </div>
        <ReasonedAction
          gate={halt}
          label={halted ? 'Resume trading' : 'Halt new risk'}
          title={halted ? 'Why it is safe to resume' : 'Why trading is being halted'}
          variant={halted ? 'neutral' : 'danger'}
          minLength={3}
          busy={halt.isPending}
          onConfirm={(reason) => halt.mutate({ halt: !halted, reason })}
        />
      </section>
      <ErrorLine error={halt.error} />

      <section className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Accounts" value={String(data.accounts.total)} />
        <Stat label="Active" value={String(data.accounts.active)} />
        <Stat label="Holding positions" value={String(data.accounts.withOpenPositions)} />
        <Stat label="Open positions" value={String(data.positions.open)} />
        <Stat label="Resting orders" value={String(data.orders.resting)} />

        <Stat label="Orders, last hour" value={String(data.orders.lastHour)} />
        <Stat
          label="Rejected, last hour"
          value={String(data.orders.rejectedLastHour)}
          tone={data.orders.rejectedLastHour > 0 ? 'text-terminal-warning' : undefined}
        />
        <Stat label="Risk events, 24h" value={String(data.risk.eventsLastDay)} />
        <Stat
          label="Critical, 24h"
          value={String(data.risk.criticalLastDay)}
          tone={data.risk.criticalLastDay > 0 ? 'text-terminal-short' : undefined}
        />
        <Stat
          label="Integrity signals"
          value={String(data.integrity.open)}
          tone={data.integrity.open > 0 ? 'text-terminal-warning' : undefined}
          title={Object.entries(data.integrity.bySeverity)
            .map(([severity, count]) => `${severity}: ${count}`)
            .join(' · ')}
        />
      </section>

      {/*
        The money, by currency and never summed across them. A firm holding
        dollars and euros has two numbers; one number made by adding them
        looks authoritative and reconciles with nothing.
      */}
      {data.money.byCurrency.length === 0 ? null : (
        <section className="space-y-2">
          <p className="text-label uppercase tracking-wider text-terminal-muted">
            Money · last 24 hours
          </p>
          <Table>
            <Head
              columns={[
                'Currency',
                'Held',
                'In',
                'Out',
                'Commission',
                'Swap',
                'Trader net P&L',
                'Closed',
                'Volume',
              ]}
            />
            <tbody>
              {data.money.byCurrency.map((row) => (
                <tr key={row.currency} className="border-t border-terminal-border/60">
                  <td className="px-3 py-1.5 text-terminal-text">{row.currency}</td>
                  <td className="numeric px-3 py-1.5">{row.balance}</td>
                  <td className="numeric px-3 py-1.5 text-terminal-long">{row.depositedLastDay}</td>
                  <td className="numeric px-3 py-1.5 text-terminal-short">
                    {row.withdrawnLastDay}
                  </td>
                  <td className="numeric px-3 py-1.5">{row.commissionLastDay}</td>
                  <td className="numeric px-3 py-1.5">{row.swapLastDay}</td>
                  <td
                    className={cn(
                      'numeric px-3 py-1.5',
                      Number(row.netPnlLastDay) < 0 ? 'text-terminal-short' : 'text-terminal-long',
                    )}
                  >
                    {row.netPnlLastDay}
                  </td>
                  <td className="numeric px-3 py-1.5">{row.closedTradesLastDay}</td>
                  <td className="numeric px-3 py-1.5">{row.volumeLastDay}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      <p className="text-label text-terminal-muted">
        Taken {utcTime(data.takenAt)} UTC · reconciliation findings in the last day{' '}
        {data.reconciliation.openFindings}
        {data.reconciliation.lastRunAt === null
          ? ''
          : `, last run ${utcTime(data.reconciliation.lastRunAt)} UTC`}
      </p>
    </div>
  );
}
