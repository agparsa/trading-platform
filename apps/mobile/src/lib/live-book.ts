import { WsEvent, type PnlUpdatePayload } from '@tp/shared-types';

/**
 * What a socket frame means for the lists this app fetched over REST.
 *
 * ## Why this exists
 *
 * The phone opened a socket, subscribed to orders, positions, account and P&L,
 * and read quotes. Every other frame was discarded on arrival. The home screen's
 * equity, the positions tab's P&L and the orders tab were fetched once and then
 * only on a pull — a trader watching a position on the phone saw the P&L from
 * the moment they opened the tab, and an order that filled stayed "working"
 * until they dragged the list. The server valued every such account on every
 * tick for a socket that threw the answer away.
 *
 * Two ways a frame is used, and they are different on purpose:
 *
 *  - **Applied.** `account.updated` and `pnl.updated` carry the figures
 *    themselves, marked by the server. They are laid over what REST returned.
 *  - **Refetched.** An order or position event says a list changed, not what
 *    the list now is: a fill creates a position whose row the frame does not
 *    carry. Those frames make the named lists stale, and the screen asks again.
 *    That is a request per event, not per interval — the difference between
 *    this and the polling the repository forbids.
 *
 * `TOPICS` is a `Record` over every wire event, so a new event cannot be added
 * without deciding here what it makes stale. A frame that makes nothing stale
 * says so with an empty list.
 */
export type LiveTopic = 'orders' | 'positions' | 'account' | 'trades';

export const LIVE_TOPICS: readonly LiveTopic[] = ['orders', 'positions', 'account', 'trades'];

const TOPICS: Readonly<Record<WsEvent, readonly LiveTopic[]>> = {
  [WsEvent.QUOTES_UPDATED]: [],
  [WsEvent.CANDLE_UPDATE]: [],
  [WsEvent.ORDER_CREATED]: ['orders'],
  [WsEvent.ORDER_UPDATED]: ['orders'],
  // A fill ends the order, opens or changes a position, and moves margin.
  [WsEvent.ORDER_FILLED]: ['orders', 'positions', 'account'],
  [WsEvent.ORDER_CANCELLED]: ['orders'],
  [WsEvent.ORDER_REJECTED]: ['orders'],
  // A position changing moves margin; a close moves the balance and realised
  // P&L, and becomes a row of the trade history.
  [WsEvent.POSITION_CREATED]: ['positions', 'account'],
  [WsEvent.POSITION_UPDATED]: ['positions'],
  [WsEvent.POSITION_CLOSED]: ['positions', 'account', 'trades'],
  // Applied, not refetched.
  [WsEvent.ACCOUNT_UPDATED]: [],
  [WsEvent.PNL_UPDATED]: [],
  // The account frames that follow carry the figures; this is a transition only.
  [WsEvent.RISK_UPDATED]: [],
};

/** The lists a frame makes stale. Unknown events make nothing stale. */
export function topicsOf(event: string): readonly LiveTopic[] {
  return (TOPICS as Record<string, readonly LiveTopic[] | undefined>)[event] ?? [];
}

/** A counter per list; a screen refetches when its counter moves. */
export type LiveVersions = Readonly<Record<LiveTopic, number>>;

export const NO_VERSIONS: LiveVersions = { orders: 0, positions: 0, account: 0, trades: 0 };

/** Moves the counters of the given lists, leaving the object alone when there are none. */
export function bump(versions: LiveVersions, topics: readonly LiveTopic[]): LiveVersions {
  if (topics.length === 0) return versions;
  const next = { ...versions };
  for (const topic of new Set(topics)) next[topic] += 1;
  return next;
}

/** The fields of a position row that a P&L frame carries. */
export interface MarkedRow {
  readonly id: string;
  readonly currentPrice: string | null;
  readonly floatingPnl: string | null;
  readonly netFloatingPnl: string | null;
  readonly stale: boolean | null;
}

/**
 * Lays the newest P&L frame over the rows REST returned.
 *
 * Matched by position id. A row the frame does not name keeps its figures —
 * it is newer than the frame, or the frame is from before it opened — and a
 * frame entry for a row the list does not have is ignored rather than
 * invented into a row: the next refetch is what brings a new position in.
 *
 * `netPnl` on the wire is `netFloatingPnl` over REST: the same figure under
 * two names, which is why this is a function and not a spread.
 */
export function applyPnl<Row extends MarkedRow>(
  rows: readonly Row[] | null,
  frame: readonly PnlUpdatePayload[] | undefined,
): readonly Row[] | null {
  if (rows === null || frame === undefined || frame.length === 0) return rows;
  const byId = new Map(frame.map((entry) => [entry.positionId, entry]));
  let changed = false;
  const next = rows.map((row) => {
    const marked = byId.get(row.id);
    if (marked === undefined) return row;
    changed = true;
    return {
      ...row,
      currentPrice: marked.currentPrice,
      floatingPnl: marked.floatingPnl,
      netFloatingPnl: marked.netPnl,
      stale: marked.stale,
    };
  });
  return changed ? next : rows;
}

/**
 * Lays an `account.updated` frame over the REST snapshot.
 *
 * The frame carries every figure the valuation computes and not the realised
 * P&L, which is read from the ledger per request and would cost the valuation
 * loop a query per account per tick. So the frame's figures win and the
 * snapshot's realised ones stay; a close that changes them moves the
 * `account` counter, and the refetch brings them.
 *
 * A frame for another account is not this one's, whatever it says; and a
 * frame older than the snapshot — a refetch that landed after it — is not
 * newer figures, so the snapshot stands until the next frame.
 */
export function applyAccount<State extends { accountId: string; updatedAt: number }>(
  snapshot: State | undefined,
  frame: (Partial<State> & { accountId: string; updatedAt: number }) | undefined,
): State | undefined {
  if (snapshot === undefined || frame === undefined) return snapshot;
  if (frame.accountId !== snapshot.accountId) return snapshot;
  if (frame.updatedAt < snapshot.updatedAt) return snapshot;
  return { ...snapshot, ...frame };
}
