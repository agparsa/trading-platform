import type { OrderLogRow } from './queries';
import { trailLines, type TrailLine } from './order-trail';

/**
 * The Logs tab's lines: the account's order events, newest first, each in
 * the same words as an order's own trail (`trailLines`) with the order it
 * belongs to named in front.
 *
 * Pages are joined by event id, not concatenated: an order placed while the
 * tab is open pushes every row down by one, and the next page's first row
 * would otherwise repeat the last one already on screen.
 */
export interface OrderLogLine extends TrailLine {
  readonly id: string;
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  /** "market", "limit", "stop limit" — the order's type, in lower case. */
  readonly orderType: string;
}

export function orderLogLines(
  pages: ReadonlyArray<{ events: readonly OrderLogRow[] }> | undefined,
): OrderLogLine[] {
  const seen = new Set<string>();
  const rows: OrderLogRow[] = [];
  for (const page of pages ?? []) {
    for (const row of page.events) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  const lines = trailLines(rows);
  return rows.map((row, index) => ({
    ...lines[index]!,
    id: row.id,
    orderId: row.orderId,
    symbol: row.symbol,
    side: row.side,
    orderType: row.orderType.toLowerCase().replace(/_/g, ' '),
  }));
}
