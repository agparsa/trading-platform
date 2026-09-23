'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Field, Tabs, inputClass } from '@/components/primitives';
import {
  useBlotterOrders,
  useBlotterPositions,
  useBlotterTrades,
  useOrderHistory,
  type BlotterFilters,
  type BlotterOrderRow,
  type BlotterPositionRow,
  type BlotterTradeRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { downloadCsv, toCsv } from '@/lib/csv';
import { ErrorLine, Head, Loading, Table } from './shared';

type BookTab = 'orders' | 'positions' | 'trades';

const ORDER_STATUSES = [
  '',
  'NEW',
  'ACCEPTED',
  'PENDING',
  'TRIGGERED',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'UNCONFIRMED',
];

/**
 * The firm's own book.
 *
 * Every trading listing on this platform is account-scoped and
 * ownership-checked, which is right for a trader and useless for the person
 * running the firm: "what is open across the book" and "why was that order
 * rejected at 14:32" meant a database console until now.
 *
 * Paging is by cursor rather than page number, because a book is read while
 * orders are still arriving and offset paging over a moving table shows some
 * rows twice and skips others. The consequence for this screen is that there
 * is a Next and a Back, and no jump to page seven — which is honest about what
 * can actually be offered.
 */
export function BookPanel() {
  const [tab, setTab] = useState<BookTab>('orders');
  const [filters, setFilters] = useState<BlotterFilters>({ limit: 100 });
  // A stack of the cursors already used, so Back is exact rather than a guess.
  const [trail, setTrail] = useState<string[]>([]);
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  const cursor = trail[trail.length - 1];
  const query: BlotterFilters = { ...filters, ...(cursor === undefined ? {} : { cursor }) };

  const orders = useBlotterOrders(tab === 'orders' ? query : { limit: 0 });
  const positions = useBlotterPositions(tab === 'positions' ? query : { limit: 0 });
  const trades = useBlotterTrades(tab === 'trades' ? query : { limit: 0 });
  const active = tab === 'orders' ? orders : tab === 'positions' ? positions : trades;

  const apply = (change: Partial<BlotterFilters>) => {
    setTrail([]);
    setFilters((current) => ({ ...current, ...change }));
  };

  return (
    <div className="flex flex-col" data-testid="book-panel">
      <div className="border-b border-terminal-border px-3 py-2">
        <Tabs<BookTab>
          active={tab}
          onChange={(next) => {
            setTrail([]);
            setOpenOrder(null);
            setTab(next);
          }}
          tabs={[
            { id: 'orders', label: 'Orders' },
            { id: 'positions', label: 'Positions' },
            { id: 'trades', label: 'Closed trades' },
          ]}
        />
      </div>

      <div className="grid gap-3 px-3 py-2 md:grid-cols-5">
        <Field label="Account" hint="the number on the ticket">
          <input
            className={cn(inputClass, 'py-1 font-mono text-xs')}
            value={filters.accountNumber ?? ''}
            onChange={(event) => apply({ accountNumber: event.target.value })}
            placeholder="TP-100001"
          />
        </Field>
        <Field label="Instrument">
          <input
            className={cn(inputClass, 'py-1 text-xs')}
            value={filters.symbol ?? ''}
            onChange={(event) => apply({ symbol: event.target.value })}
            placeholder="XAUUSD"
          />
        </Field>
        <Field label="Side">
          <select
            className={cn(inputClass, 'py-1 text-xs')}
            value={filters.side ?? ''}
            onChange={(event) =>
              apply({ side: (event.target.value || undefined) as 'BUY' | 'SELL' | undefined })
            }
          >
            <option value="">any</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </Field>
        <Field label="Status">
          <select
            className={cn(inputClass, 'py-1 text-xs')}
            value={filters.status ?? ''}
            onChange={(event) => apply({ status: event.target.value || undefined })}
          >
            {(tab === 'positions' ? ['', 'OPEN', 'CLOSING', 'CLOSED'] : ORDER_STATUSES).map(
              (status) => (
                <option key={status} value={status}>
                  {status === '' ? (tab === 'positions' ? 'open' : 'any') : status}
                </option>
              ),
            )}
          </select>
        </Field>
        <div className="flex items-end gap-2">
          {/*
            The page, not the dataset — and it says so. An "Export" that
            silently gave one screen of a hundred thousand rows would be
            worse than no export at all.
          */}
          <Button
            variant="neutral"
            onClick={() => {
              const rows = (active.data?.rows ?? []) as unknown as ReadonlyArray<
                Record<string, unknown>
              >;
              const first = rows[0];
              if (first === undefined) return;
              const columns = Object.keys(first);
              downloadCsv(
                toCsv(
                  columns,
                  rows.map((row) => columns.map((column) => String(row[column] ?? ''))),
                ),
                `${tab}-${new Date().toISOString().slice(0, 10)}.csv`,
              );
            }}
            disabled={(active.data?.rows.length ?? 0) === 0}
          >
            Export this page
          </Button>
        </div>
      </div>
      <ErrorLine error={active.error} />

      {active.isLoading ? (
        <Loading />
      ) : (active.data?.rows.length ?? 0) === 0 ? (
        <Loading>Nothing matches.</Loading>
      ) : tab === 'orders' ? (
        <OrdersTable rows={orders.data?.rows ?? []} onOpen={setOpenOrder} />
      ) : tab === 'positions' ? (
        <PositionsTable rows={positions.data?.rows ?? []} />
      ) : (
        <TradesTable rows={trades.data?.rows ?? []} />
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] text-terminal-muted">
          {active.data?.rows.length ?? 0} shown
          {active.data?.nextCursor === null ? '' : ' · more'}
        </span>
        <span className="space-x-2">
          <Button
            variant="ghost"
            onClick={() => setTrail((current) => current.slice(0, -1))}
            disabled={trail.length === 0}
          >
            Back
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const next = active.data?.nextCursor;
              if (next != null) setTrail((current) => [...current, next]);
            }}
            disabled={active.data?.nextCursor == null}
          >
            Next
          </Button>
        </span>
      </div>

      {openOrder === null ? null : (
        <OrderHistory orderId={openOrder} onClose={() => setOpenOrder(null)} />
      )}
    </div>
  );
}

function OrdersTable({
  rows,
  onOpen,
}: {
  rows: readonly BlotterOrderRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <Table>
      <Head
        columns={['When', 'Account', 'Instrument', 'Side', 'Type', 'Volume', 'Price', 'Status', '']}
      />
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-terminal-border/60">
            <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
              {utcTime(row.createdAt)}
            </td>
            <td className="px-3 py-1.5">
              <p className="font-mono text-[11px]">{row.accountNumber}</p>
              <p className="text-[10px] text-terminal-muted">{row.ownerEmail}</p>
            </td>
            <td className="px-3 py-1.5 text-terminal-text">{row.symbol}</td>
            <td
              className={cn(
                'px-3 py-1.5',
                row.side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
              )}
            >
              {row.side}
            </td>
            <td className="px-3 py-1.5 text-[10px] text-terminal-muted">{row.type}</td>
            <td className="numeric px-3 py-1.5">
              {row.filledVolume === row.volume ? row.volume : `${row.filledVolume}/${row.volume}`}
            </td>
            <td className="numeric px-3 py-1.5">{row.price ?? '—'}</td>
            <td className="px-3 py-1.5 text-[11px]">
              {row.status}
              {row.rejectionCode === null ? null : (
                <p className="text-[10px] text-terminal-short">{row.rejectionCode}</p>
              )}
            </td>
            <td className="px-3 py-1.5 text-right">
              <Button variant="ghost" onClick={() => onOpen(row.id)}>
                History
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PositionsTable({ rows }: { rows: readonly BlotterPositionRow[] }) {
  return (
    <Table>
      <Head
        columns={['Opened', 'Account', 'Instrument', 'Side', 'Volume', 'Entry', 'Margin', 'Status']}
      />
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-terminal-border/60">
            <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
              {utcTime(row.openedAt)}
            </td>
            <td className="px-3 py-1.5">
              <p className="font-mono text-[11px]">{row.accountNumber}</p>
              <p className="text-[10px] text-terminal-muted">{row.ownerEmail}</p>
            </td>
            <td className="px-3 py-1.5 text-terminal-text">{row.symbol}</td>
            <td
              className={cn(
                'px-3 py-1.5',
                row.side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
              )}
            >
              {row.side}
            </td>
            <td className="numeric px-3 py-1.5">{row.volume}</td>
            <td className="numeric px-3 py-1.5">{row.entryPrice}</td>
            <td className="numeric px-3 py-1.5">{row.margin}</td>
            <td className="px-3 py-1.5 text-[11px]">{row.status}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function TradesTable({ rows }: { rows: readonly BlotterTradeRow[] }) {
  return (
    <Table>
      <Head
        columns={[
          'Closed',
          'Account',
          'Instrument',
          'Side',
          'Volume',
          'Entry → Exit',
          'Gross',
          'Cost',
          'Net',
        ]}
      />
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-terminal-border/60">
            <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
              {utcTime(row.exitTime)}
            </td>
            <td className="px-3 py-1.5">
              <p className="font-mono text-[11px]">{row.accountNumber}</p>
              <p className="text-[10px] text-terminal-muted">{row.ownerEmail}</p>
            </td>
            <td className="px-3 py-1.5 text-terminal-text">{row.symbol}</td>
            <td
              className={cn(
                'px-3 py-1.5',
                row.side === 'BUY' ? 'text-terminal-long' : 'text-terminal-short',
              )}
            >
              {row.side}
            </td>
            <td className="numeric px-3 py-1.5">{row.volume}</td>
            <td className="numeric px-3 py-1.5 text-[10px]">
              {row.entryPrice} → {row.exitPrice}
            </td>
            <td className="numeric px-3 py-1.5">{row.grossPnl}</td>
            {/* Commission and swap together: what the round trip cost to do. */}
            <td className="numeric px-3 py-1.5 text-terminal-muted">
              {row.commission} / {row.swap}
            </td>
            <td
              className={cn(
                'numeric px-3 py-1.5',
                Number(row.netPnl) < 0 ? 'text-terminal-short' : 'text-terminal-long',
              )}
            >
              {row.netPnl}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Everything that happened to one order — the answer to "why was that
 * rejected", which is the question a support agent is actually asked. These
 * are the order's own events, written at every transition and never edited, so
 * this is the record rather than a reconstruction.
 */
function OrderHistory({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const history = useOrderHistory(orderId);

  return (
    <div className="border-t border-terminal-border px-3 py-3" data-testid="order-history">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Order history</p>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <ErrorLine error={history.error} />
      {history.isLoading ? (
        <Loading />
      ) : (
        <Table>
          <Head columns={['When', 'What', 'From', 'To', 'Detail']} />
          <tbody>
            {(history.data?.events ?? []).map((event) => (
              <tr key={event.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                  {utcTime(event.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-text">{event.type}</td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  {event.fromStatus ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-[10px]">{event.toStatus ?? '—'}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {event.payload === null ? '—' : JSON.stringify(event.payload)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
