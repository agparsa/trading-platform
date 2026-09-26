'use client';

import { Fragment, useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { entrySideOf } from '@tp/financial-core';
import { DomainError } from '@tp/shared-types';
import { price as formatPrice, utcTime, volume as formatVolume } from '@/lib/format';
import { distanceInPoints, triggerSide } from '@/lib/points';
import { shortRefs } from '@/lib/refs';
import {
  useCancelPending,
  useModifyPending,
  type PendingOrderRow,
  type SymbolRow,
} from '@/lib/queries';
import { useRealtime } from '@/lib/realtime-store';
import { Button, EmptyState, SideBadge, inputClass } from './primitives';

/**
 * Resting LIMIT and STOP orders.
 *
 * Kept apart from open positions because they are a different kind of thing: a
 * position is money at risk now, a resting order is an instruction that may
 * never fire. Showing them in one list would let a trader read a pending order
 * as exposure they already have.
 */
export function PendingPanel({
  orders,
  symbols,
  accountId,
}: {
  orders: readonly PendingOrderRow[];
  symbols: readonly SymbolRow[];
  accountId: string | null;
}) {
  const cancel = useCancelPending(accountId);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const quotes = useRealtime((state) => state.quotes);

  const refs = useMemo(() => shortRefs(orders.map((order) => order.orderId)), [orders]);

  const precisionOf = (code: string) =>
    symbols.find((symbol) => symbol.code === code)?.pricePrecision ?? 2;

  const run = async (orderId: string) => {
    setError(null);
    setWorking(orderId);
    try {
      await cancel.mutateAsync({ orderId });
    } catch (caught) {
      setError(
        caught instanceof DomainError
          ? caught.message
          : 'The order could not be cancelled. Nothing was changed.',
      );
    } finally {
      setWorking(null);
    }
  };

  if (orders.length === 0) {
    return <EmptyState>No resting orders.</EmptyState>;
  }

  return (
    <div>
      {error === null ? null : <p className="px-3 py-2 text-[11px] text-terminal-short">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-terminal-surface">
            <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
              <th className="px-3 py-1.5 font-medium" title="Order reference">
                Ref
              </th>
              <th className="px-2 py-1.5 font-medium">Placed (UTC)</th>
              <th className="px-2 py-1.5 font-medium">Symbol</th>
              <th className="px-2 py-1.5 font-medium">Side</th>
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 text-right font-medium">Volume</th>
              <th className="px-2 py-1.5 text-right font-medium">Price</th>
              <th
                className="px-2 py-1.5 text-right font-medium"
                title="How far the market is from the trigger price right now"
              >
                Distance
              </th>
              <th className="px-2 py-1.5 text-right font-medium">S/L</th>
              <th className="px-2 py-1.5 text-right font-medium">T/P</th>
              <th className="px-2 py-1.5 font-medium">Valid</th>
              <th className="px-3 py-1.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const precision = precisionOf(order.symbol);
              const quote = quotes[order.symbol];
              /**
               * The side of the book this order would actually fire against —
               * a BUY fills at the ask, a SELL at the bid. Using the mid here
               * would understate the distance on a wide spread, which is exactly
               * when the difference matters.
               */
              const reference = triggerSide(order.side, quote);
              const distance = distanceInPoints(order.price, reference, precision);

              return (
                <Fragment key={order.orderId}>
                  <tr className="border-t border-terminal-border/60 hover:bg-terminal-raised/40">
                    <td className="numeric px-3 py-1.5 text-[10px] tracking-wide text-terminal-muted">
                      <span title={order.orderId}>{refs.get(order.orderId) ?? order.orderId}</span>
                    </td>
                    <td className="numeric px-2 py-1.5 text-terminal-muted">
                      {utcTime(order.createdAt)}
                    </td>
                    <td className="px-2 py-1.5 font-medium text-terminal-text">{order.symbol}</td>
                    <td className="px-2 py-1.5">
                      <SideBadge side={order.side} />
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="rounded bg-terminal-raised px-1.5 py-0.5 text-[10px] text-terminal-muted">
                        {order.type}
                      </span>
                    </td>
                    <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                      {formatVolume(order.volume)}
                    </td>
                    <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                      {formatPrice(order.price, precision)}
                    </td>
                    <td
                      className="numeric px-2 py-1.5 text-right text-terminal-muted"
                      title={
                        reference === null
                          ? 'No live quote for this instrument yet'
                          : `Against the ${entrySideOf(order.side)} of ${reference}`
                      }
                    >
                      {distance === null ? '—' : `${distance} pt`}
                    </td>
                    <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                      {order.stopLoss === null ? '—' : formatPrice(order.stopLoss, precision)}
                    </td>
                    <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                      {order.takeProfit === null ? '—' : formatPrice(order.takeProfit, precision)}
                    </td>
                    <td
                      className="px-2 py-1.5 text-terminal-muted"
                      title={
                        order.expiresAt === null
                          ? 'Rests until cancelled'
                          : `Expires ${utcTime(order.expiresAt)} UTC`
                      }
                    >
                      {order.timeInForce}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          className="px-2 py-0.5"
                          onClick={() =>
                            setEditing(editing === order.orderId ? null : order.orderId)
                          }
                        >
                          {editing === order.orderId ? 'Close' : 'Modify'}
                        </Button>
                        <Button
                          variant="danger"
                          className={cn('px-2 py-0.5')}
                          disabled={working !== null}
                          onClick={() => void run(order.orderId)}
                        >
                          {working === order.orderId ? 'Cancelling…' : 'Cancel'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {editing === order.orderId ? (
                    <tr className="border-t border-terminal-border/60">
                      <td colSpan={12} className="bg-terminal-bg px-3 py-3">
                        <PendingEditor
                          order={order}
                          accountId={accountId}
                          onDone={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        No margin is held while an order rests. It is checked again when the order fires.
      </p>
    </div>
  );
}

/**
 * Editing a resting order.
 *
 * `PATCH /orders/:id` replaces only the fields sent, so an untouched field must
 * be *omitted* rather than sent back as it was: re-sending the current price
 * would make an unrelated concurrent change silently disappear. The form starts
 * from the order's current values and sends only what actually differs.
 */
function PendingEditor({
  order,
  accountId,
  onDone,
}: {
  order: PendingOrderRow;
  accountId: string | null;
  onDone: () => void;
}) {
  const [price, setPrice] = useState(order.price);
  const [volume, setVolume] = useState(order.volume);
  const [stopLoss, setStopLoss] = useState(order.stopLoss ?? '');
  const [takeProfit, setTakeProfit] = useState(order.takeProfit ?? '');
  const [error, setError] = useState<string | null>(null);

  const modify = useModifyPending(accountId);

  const apply = async () => {
    setError(null);
    const body: {
      orderId: string;
      price?: string;
      volume?: string;
      stopLoss?: string | null;
      takeProfit?: string | null;
    } = { orderId: order.orderId };

    if (price.trim() !== order.price) body.price = price.trim();
    if (volume.trim() !== order.volume) body.volume = volume.trim();

    const nextStop = stopLoss.trim() === '' ? null : stopLoss.trim();
    if (nextStop !== order.stopLoss) body.stopLoss = nextStop;
    const nextTake = takeProfit.trim() === '' ? null : takeProfit.trim();
    if (nextTake !== order.takeProfit) body.takeProfit = nextTake;

    if (Object.keys(body).length === 1) {
      setError('Nothing was changed.');
      return;
    }

    try {
      await modify.mutateAsync(body);
      onDone();
    } catch (caught) {
      setError(
        caught instanceof DomainError
          ? caught.message
          : 'The order could not be modified. Nothing was changed.',
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Labelled label="Trigger price" value={price} onChange={setPrice} />
        <Labelled label="Volume" value={volume} onChange={setVolume} />
        <Labelled label="Stop loss" value={stopLoss} onChange={setStopLoss} />
        <Labelled label="Take profit" value={takeProfit} onChange={setTakeProfit} />
        <Button variant="neutral" disabled={modify.isPending} onClick={() => void apply()}>
          {modify.isPending ? 'Applying…' : 'Apply'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Discard
        </Button>
      </div>
      <p className="text-[10px] text-terminal-muted">
        Only the fields you change are sent. An empty stop or target clears it.
      </p>
      {error === null ? null : <p className="text-[11px] text-terminal-short">{error}</p>}
    </div>
  );
}

function Labelled({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
        {label}
      </span>
      <input
        className={cn(inputClass, 'w-32')}
        placeholder="—"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
