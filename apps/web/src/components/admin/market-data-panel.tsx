'use client';

import { cn } from '@tp/ui';
import { useMarketData, type MarketProviderRow } from '@/lib/admin-queries';
import { ErrorLine, Head, Loading, Table } from './shared';

const STATE_TONE: Record<MarketProviderRow['state'], string> = {
  connected: 'text-terminal-long',
  connecting: 'text-terminal-warning',
  disconnected: 'text-terminal-short',
};

function age(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/**
 * Where every price comes from, and whether it is fit to trade on.
 *
 * The sources are what the ingesting instance last reported: connected or
 * not, since when, how many ticks, how many reconnections, the last error in
 * words. The instruments are the platform's own latest quotes, aged against
 * each instrument's own limit — the same judgement the engine makes before a
 * fill. "simulator" is said plainly: an instrument no live source covers is
 * priced by the platform's simulator, and an operator must be able to see that
 * at a glance. Read-only; there is no key or address anywhere on it.
 */
export function MarketDataPanel() {
  const view = useMarketData();
  if (view.isPending) return <Loading>Loading market data…</Loading>;
  if (view.isError) return <ErrorLine error={view.error} />;
  const data = view.data;
  const reportAge = data.reportedAt === null ? null : data.at - data.reportedAt;

  return (
    <div className="space-y-4 p-3" data-testid="market-data">
      <section>
        <h2 className="mb-2 text-label uppercase tracking-wider text-terminal-muted">Sources</h2>
        {data.reportedAt === null ? (
          <p className="text-caption text-terminal-muted">
            No source has reported. Either no live source is configured, or the ingesting instance
            is not running — every instrument below is priced by the simulator.
          </p>
        ) : (
          <>
            <p className="mb-2 text-caption text-terminal-muted">
              Reported by the ingesting instance {age(reportAge)} ago.
            </p>
            <Table>
              <Head
                columns={[
                  'Source',
                  'State',
                  'Since',
                  'Instruments',
                  { label: 'Ticks', right: true },
                  { label: 'Last tick', right: true },
                  { label: 'Source lag', right: true },
                  { label: 'Reconnects', right: true },
                  'Last error',
                ]}
              />
              <tbody>
                {data.providers.map((row) => (
                  <tr key={row.name} className="border-t border-terminal-border/60">
                    <td className="px-2 py-1.5 font-medium text-terminal-text">{row.name}</td>
                    <td className={cn('px-2 py-1.5', STATE_TONE[row.state])}>{row.state}</td>
                    <td className="px-2 py-1.5 text-terminal-muted">
                      {age(data.at - row.since)} ago
                    </td>
                    <td className="px-2 py-1.5 text-terminal-muted">{row.symbols.join(', ')}</td>
                    <td className="numeric px-2 py-1.5 text-end">{row.ticks}</td>
                    <td className="numeric px-2 py-1.5 text-end">
                      {row.lastTickAt === null ? '—' : `${age(data.at - row.lastTickAt)} ago`}
                    </td>
                    <td
                      className="numeric px-2 py-1.5 text-end"
                      title="How old the last tick's own time was when it arrived"
                    >
                      {row.lastTickAt === null || row.lastSourceTime === null
                        ? '—'
                        : age(row.lastTickAt - row.lastSourceTime)}
                    </td>
                    <td className="numeric px-2 py-1.5 text-end">{row.reconnects}</td>
                    <td className="px-2 py-1.5 text-terminal-muted">{row.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-label uppercase tracking-wider text-terminal-muted">
          Instruments
        </h2>
        <Table>
          <Head
            columns={[
              'Instrument',
              'Priced by',
              { label: 'Bid', right: true },
              { label: 'Ask', right: true },
              { label: 'Age', right: true },
              { label: 'Limit', right: true },
              'Tradeable price',
            ]}
          />
          <tbody>
            {data.instruments.map((row) => (
              <tr
                key={row.symbol}
                className="border-t border-terminal-border/60"
                data-testid="market-data-row"
              >
                <td className="px-2 py-1.5 font-medium text-terminal-text">{row.symbol}</td>
                <td
                  className={cn(
                    'px-2 py-1.5',
                    row.source === 'simulator' || row.source === 'none'
                      ? 'text-terminal-warning'
                      : 'text-terminal-text',
                  )}
                >
                  {row.source}
                </td>
                <td className="numeric px-2 py-1.5 text-end">{row.bid ?? '—'}</td>
                <td className="numeric px-2 py-1.5 text-end">{row.ask ?? '—'}</td>
                <td className="numeric px-2 py-1.5 text-end">{age(row.ageMs)}</td>
                <td className="numeric px-2 py-1.5 text-end">{age(row.maxAgeMs)}</td>
                <td
                  className={cn(
                    'px-2 py-1.5',
                    row.stale ? 'text-terminal-short' : 'text-terminal-long',
                  )}
                >
                  {row.stale ? 'stale — orders refused' : 'fresh'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
