'use client';

import { Button } from '@/components/primitives';
import {
  useResolveUnconfirmed,
  useUnconfirmedOrders,
  type UnconfirmedOrderRow,
} from '@/lib/admin-queries';
import { usePermissions } from '@/lib/queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * Orders whose answers were lost.
 *
 * An order on this list left the platform and the venue's reply never came
 * back. It may be filled, working, or never to have existed — and until the
 * venue says which, the platform will not pretend to know.
 *
 * So the only action here is **ask again**. There is deliberately no button
 * that marks one filled or cancelled: that is the venue's answer to give, and
 * a person guessing it is how a platform books a position the venue does not
 * hold. A resend is not offered either — one intent must not become two
 * positions. If the venue turns out never to have received the order it is
 * cancelled, and placing it again at today&apos;s price is the trader&apos;s
 * decision to make.
 *
 * The background sweep does this by itself every few seconds. This screen is
 * for the case it cannot settle: a venue that has been unreachable for an
 * hour, and orders that have been waiting since.
 */
export function UnconfirmedOrdersPanel() {
  const orders = useUnconfirmedOrders();
  const resolve = useResolveUnconfirmed();
  const permissions = usePermissions();
  const mayAsk = permissions.data?.permissions.includes('orders.modify') ?? false;
  const rows = orders.data?.orders ?? [];

  return (
    <div className="flex flex-col" data-testid="unconfirmed-orders-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-terminal-muted">
          Sent to a venue, with no answer back. The platform asks again on its own; this is where
          you can ask now. Nothing here decides an order&apos;s outcome — only the venue can.
        </p>
        <span className="text-[10px] text-terminal-muted">
          {rows.length} waiting
        </span>
      </div>
      <ErrorLine error={orders.error ?? resolve.error} />

      {orders.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nothing is waiting on a venue.</Loading>
      ) : (
        <Table>
          <Head columns={['Waiting since', 'Order', 'Sent as', 'Account', '']} />
          <tbody>
            {rows.map((row: UnconfirmedOrderRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60">
                <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px]">{row.id}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.clientOrderId ?? '—'}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.accountId}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {mayAsk ? (
                    <Button
                      variant="neutral"
                      onClick={() => resolve.mutate(row.id)}
                      disabled={resolve.isPending}
                    >
                      {resolve.isPending ? 'Asking…' : 'Ask the venue'}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
