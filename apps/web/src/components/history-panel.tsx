'use client';

import { cn } from '@tp/ui';
import {
  money,
  price as formatPrice,
  signedMoney,
  toneClass,
  toneOf,
  utcTime,
  volume as formatVolume,
} from '@/lib/format';
import { useOrders, usePositions, useTrades, type SymbolRow } from '@/lib/queries';
import { EmptyState, SideBadge } from './primitives';

export type HistoryTab = 'trades' | 'closed' | 'orders';

/**
 * Completed activity.
 *
 * Three views of the same history, because they answer different questions:
 * *trades* are the round trips a trader's P&L is made of, *closed positions* are
 * the position records those round trips came from, and *orders* are the
 * instructions — including the ones the engine rejected. A terminal that only
 * shows fills hides its own refusals.
 */
export function HistoryPanel({
  tab,
  accountId,
  symbols,
  currency,
}: {
  tab: HistoryTab;
  accountId: string | null;
  symbols: readonly SymbolRow[];
  currency: string;
}) {
  const precisionOf = (code: string) =>
    symbols.find((symbol) => symbol.code === code)?.pricePrecision ?? 2;

  const trades = useTrades(accountId, tab === 'trades');
  const closed = usePositions(accountId, true);
  const orders = useOrders(accountId, tab === 'orders');

  if (tab === 'trades') {
    const rows = trades.data ?? [];
    if (rows.length === 0) return <EmptyState>No completed trades yet.</EmptyState>;
    return (
      <Table
        head={[
          'Closed',
          'Symbol',
          'Side',
          'Volume',
          'Entry',
          'Exit',
          'Commission',
          'Swap',
          'Net P&L',
        ]}
      >
        {rows.map((trade) => (
          <tr key={trade.id} className="border-t border-terminal-border/60">
            <Cell muted>{utcTime(trade.exitTime)}</Cell>
            <Cell>{trade.symbol}</Cell>
            <td className="px-2 py-1.5">
              <SideBadge side={trade.side} />
            </td>
            <Cell right>{formatVolume(trade.volume)}</Cell>
            <Cell right muted>
              {formatPrice(trade.entryPrice, precisionOf(trade.symbol))}
            </Cell>
            <Cell right muted>
              {formatPrice(trade.exitPrice, precisionOf(trade.symbol))}
            </Cell>
            <td
              className="numeric px-2 py-1.5 text-right text-terminal-muted"
              title={`Entry ${trade.entryCommission} + exit ${trade.exitCommission}`}
            >
              {money(trade.commission, currency)}
            </td>
            <Cell right muted>
              {money(trade.swap, currency)}
            </Cell>
            <td
              className={cn('numeric px-2 py-1.5 text-right', toneClass[toneOf(trade.netPnl)])}
              title={`Gross ${trade.grossPnl}${trade.closeReason === null ? '' : ` · ${trade.closeReason}`}`}
            >
              {signedMoney(trade.netPnl, currency)}
            </td>
          </tr>
        ))}
      </Table>
    );
  }

  if (tab === 'closed') {
    const rows = (closed.data ?? []).filter((position) => position.closedAt !== null);
    if (rows.length === 0) return <EmptyState>No closed positions yet.</EmptyState>;
    return (
      <Table head={['Closed', 'Symbol', 'Side', 'Volume', 'Entry', 'Reason', 'Realized P&L']}>
        {rows.map((position) => (
          <tr key={position.id} className="border-t border-terminal-border/60">
            <Cell muted>{position.closedAt === null ? '—' : utcTime(position.closedAt)}</Cell>
            <Cell>{position.symbol}</Cell>
            <td className="px-2 py-1.5">
              <SideBadge side={position.side} />
            </td>
            <Cell right>{formatVolume(position.initialVolume)}</Cell>
            <Cell right muted>
              {formatPrice(position.entryPrice, precisionOf(position.symbol))}
            </Cell>
            <Cell muted>{position.closeReason ?? '—'}</Cell>
            <td
              className={cn(
                'numeric px-2 py-1.5 text-right',
                toneClass[toneOf(position.realizedPnl)],
              )}
            >
              {signedMoney(position.realizedPnl, currency)}
            </td>
          </tr>
        ))}
      </Table>
    );
  }

  const rows = orders.data ?? [];
  if (rows.length === 0) return <EmptyState>No orders yet.</EmptyState>;
  return (
    <Table head={['Created', 'Symbol', 'Side', 'Type', 'Volume', 'Filled', 'Status']}>
      {rows.map((order) => (
        <tr key={order.id} className="border-t border-terminal-border/60">
          <Cell muted>{utcTime(order.createdAt)}</Cell>
          <Cell>{order.symbol}</Cell>
          <td className="px-2 py-1.5">
            <SideBadge side={order.side} />
          </td>
          <Cell muted>{order.type}</Cell>
          <Cell right>{formatVolume(order.volume)}</Cell>
          <Cell right muted>
            {formatVolume(order.filledVolume)}
          </Cell>
          <td className="px-2 py-1.5">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                order.status === 'FILLED'
                  ? 'bg-terminal-long/15 text-terminal-long'
                  : order.status === 'REJECTED' || order.status === 'CANCELLED'
                    ? 'bg-terminal-short/15 text-terminal-short'
                    : 'bg-terminal-raised text-terminal-muted',
              )}
            >
              {order.status}
            </span>
          </td>
        </tr>
      ))}
    </Table>
  );
}

function Table({ head, children }: { head: readonly string[]; children: React.ReactNode }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-terminal-surface">
        <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
          {head.map((label, index) => (
            <th
              key={label}
              className={cn(
                'px-2 py-1.5 font-medium',
                index === 0 && 'pl-3',
                index === head.length - 1 && 'pr-3 text-right',
              )}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Cell({
  children,
  right,
  muted,
}: {
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        'numeric px-2 py-1.5',
        right === true && 'text-right',
        muted === true ? 'text-terminal-muted' : 'text-terminal-text',
      )}
    >
      {children}
    </td>
  );
}
