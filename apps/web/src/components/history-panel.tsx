'use client';

import { useState } from 'react';
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
import {
  useOrderEvents,
  useOrders,
  usePositions,
  useTrades,
  type OrderRow,
  type PositionRow,
  type SymbolRow,
  type TradeRow,
} from '@/lib/queries';
import { trailLines } from '@/lib/order-trail';
import { ExportBar } from './export-bar';
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
  /** The one order whose trail is open. */
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  if (tab === 'trades') {
    const unknown = notYetKnown(trades);
    if (unknown !== null) return unknown;
    const rows = trades.data ?? [];
    if (rows.length === 0) return <EmptyState>No completed trades yet.</EmptyState>;
    return (
      <>
        <ExportBar
          label={`${rows.length} trade(s)`}
          filename="trades"
          columns={TRADE_COLUMNS}
          rows={rows.map(tradeToRow)}
        />
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
      </>
    );
  }

  if (tab === 'closed') {
    const unknown = notYetKnown(closed);
    if (unknown !== null) return unknown;
    const rows = (closed.data ?? []).filter((position) => position.closedAt !== null);
    if (rows.length === 0) return <EmptyState>No closed positions yet.</EmptyState>;
    return (
      <>
        <ExportBar
          label={`${rows.length} closed position(s)`}
          filename="closed-positions"
          columns={POSITION_COLUMNS}
          rows={rows.map(positionToRow)}
        />
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
      </>
    );
  }

  const unknown = notYetKnown(orders);
  if (unknown !== null) return unknown;
  const rows = orders.data ?? [];
  if (rows.length === 0) return <EmptyState>No orders yet.</EmptyState>;
  return (
    <>
      <ExportBar
        label={`${rows.length} order(s)`}
        filename="orders"
        columns={ORDER_COLUMNS}
        rows={rows.map(orderToRow)}
      />
      <Table head={['Created', 'Symbol', 'Side', 'Type', 'Volume', 'Filled', 'Status', 'Trail']}>
        {rows.map((order) => (
          <OrderRowWithTrail
            key={order.id}
            order={order}
            open={openOrder === order.id}
            onToggle={() => setOpenOrder((now) => (now === order.id ? null : order.id))}
          />
        ))}
      </Table>
    </>
  );
}

/**
 * "No orders yet" is a claim about the account, and it was made while the
 * list was still loading — and when it had failed to load. Both now say what
 * they are.
 */
function notYetKnown(query: { isError: boolean; data: unknown }): React.ReactElement | null {
  if (query.isError) return <EmptyState>This could not be loaded. It will retry.</EmptyState>;
  if (query.data === undefined) return <EmptyState>Loading…</EmptyState>;
  return null;
}

/**
 * One order, and — opened — everything that happened to it, from the
 * server's own trail (`GET /orders/:id/events`): when it was placed, checked,
 * triggered, changed, filled, refused or cancelled, and why. The Orders tab
 * shows where each order ended; the trail answers how it got there, which is
 * the question a trader asks about the order that did not fill.
 */
function OrderRowWithTrail({
  order,
  open,
  onToggle,
}: {
  order: OrderRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-terminal-border/60">
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
              'rounded px-1.5 py-0.5 text-label',
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
        <td className="py-1.5 pl-2 pr-3 text-right">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? `trail-${order.id}` : undefined}
            aria-label={`${open ? 'Hide the trail of' : 'Show the trail of'} the ${order.symbol} order from ${utcTime(order.createdAt)}`}
            onClick={onToggle}
            className="rounded border border-terminal-border px-2 py-0.5 text-caption text-terminal-text hover:bg-terminal-raised"
          >
            {open ? 'Hide' : 'Trail'}
          </button>
        </td>
      </tr>
      {open ? <TrailRow orderId={order.id} /> : null}
    </>
  );
}

function TrailRow({ orderId }: { orderId: string }) {
  const events = useOrderEvents(orderId);
  return (
    <tr id={`trail-${orderId}`} className="bg-terminal-raised/40">
      <td colSpan={8} className="px-3 py-2">
        {events.isError ? (
          <span className="text-caption text-terminal-muted">The trail could not be loaded.</span>
        ) : events.data === undefined ? (
          <span className="text-caption text-terminal-muted">Loading the trail…</span>
        ) : events.data.length === 0 ? (
          <span className="text-caption text-terminal-muted">
            Nothing is recorded for this order.
          </span>
        ) : (
          <ol className="space-y-0.5" data-testid="order-trail">
            {trailLines(events.data).map((line, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-3 text-caption">
                <span className="numeric text-terminal-muted">{utcTime(line.at)}</span>
                <span className="font-medium text-terminal-text">{line.label}</span>
                {line.facts === '' ? null : (
                  <span className="numeric text-terminal-muted">{line.facts}</span>
                )}
                {line.reason === null ? null : (
                  <span className="text-terminal-warning">{line.reason}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </td>
    </tr>
  );
}

const TRADE_COLUMNS = [
  'entryTime',
  'exitTime',
  'symbol',
  'side',
  'volume',
  'entryPrice',
  'exitPrice',
  'grossPnl',
  'entryCommission',
  'exitCommission',
  'commission',
  'swap',
  'netPnl',
  'closeReason',
  'tradeId',
];

function tradeToRow(trade: TradeRow): readonly string[] {
  return [
    trade.entryTime,
    trade.exitTime,
    trade.symbol,
    trade.side,
    trade.volume,
    trade.entryPrice,
    trade.exitPrice,
    trade.grossPnl,
    trade.entryCommission,
    trade.exitCommission,
    trade.commission,
    trade.swap,
    trade.netPnl,
    trade.closeReason ?? '',
    trade.id,
  ];
}

const POSITION_COLUMNS = [
  'openedAt',
  'closedAt',
  'symbol',
  'side',
  'initialVolume',
  'entryPrice',
  'margin',
  'commission',
  'swap',
  'realizedPnl',
  'closeReason',
  'positionId',
];

function positionToRow(position: PositionRow): readonly string[] {
  return [
    position.openedAt,
    position.closedAt ?? '',
    position.symbol,
    position.side,
    position.initialVolume,
    position.entryPrice,
    position.margin,
    position.commission,
    position.swap,
    position.realizedPnl,
    position.closeReason ?? '',
    position.id,
  ];
}

const ORDER_COLUMNS = [
  'createdAt',
  'symbol',
  'side',
  'type',
  'status',
  'volume',
  'filledVolume',
  'positionId',
  'orderId',
];

function orderToRow(order: OrderRow): readonly string[] {
  return [
    order.createdAt,
    order.symbol,
    order.side,
    order.type,
    order.status,
    order.volume,
    order.filledVolume,
    order.positionId ?? '',
    order.id,
  ];
}

function Table({ head, children }: { head: readonly string[]; children: React.ReactNode }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-terminal-surface">
        <tr className="text-left text-label uppercase tracking-wider text-terminal-muted">
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
