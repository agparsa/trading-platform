'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import { price as formatPrice, utcTime, volume as formatVolume } from '@/lib/format';
import { useCancelPending, type PendingOrderRow, type SymbolRow } from '@/lib/queries';
import { Button, EmptyState, SideBadge } from './primitives';

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

  if (orders.length === 0) {
    return <EmptyState>No resting orders.</EmptyState>;
  }

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

  return (
    <div>
      {error === null ? null : <p className="px-3 py-2 text-[11px] text-terminal-short">{error}</p>}
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-terminal-surface">
          <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
            <th className="px-3 py-1.5 font-medium">Placed</th>
            <th className="px-2 py-1.5 font-medium">Symbol</th>
            <th className="px-2 py-1.5 font-medium">Side</th>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 text-right font-medium">Volume</th>
            <th className="px-2 py-1.5 text-right font-medium">Price</th>
            <th className="px-2 py-1.5 text-right font-medium">S/L</th>
            <th className="px-2 py-1.5 text-right font-medium">T/P</th>
            <th className="px-2 py-1.5 font-medium">Valid</th>
            <th className="px-3 py-1.5 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const precision = precisionOf(order.symbol);
            return (
              <tr key={order.orderId} className="border-t border-terminal-border/60">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
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
                  <Button
                    variant="danger"
                    className={cn('px-2 py-0.5')}
                    disabled={working !== null}
                    onClick={() => void run(order.orderId)}
                  >
                    {working === order.orderId ? 'Cancelling…' : 'Cancel'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        No margin is held while an order rests. It is checked again when the order fires.
      </p>
    </div>
  );
}
