import type { Position } from '@prisma/client';

/** What `valuate()` says about one position; absent for a row nobody has valued yet. */
export interface PositionValuationView {
  floatingPnl?: { toString(): string } | null;
  netPnl?: { toString(): string } | null;
  stale?: boolean | null;
}

/**
 * A position as every client is given it — the one shape, built in one place.
 *
 * `GET /positions` answers with these, and so does the acknowledgement of a
 * market order that filled: the trader's screen can show the position the
 * moment the order is answered, from the server's own row, rather than after a
 * second request for the list. Without a valuation the floating figures are
 * `null` — not zero — and the next account frame fills them.
 */
export function positionView(
  position: Position,
  symbolCode: string,
  valuation?: PositionValuationView,
) {
  return {
    id: position.id,
    symbol: symbolCode,
    side: position.side,
    status: position.status,
    volume: position.volume.toString(),
    initialVolume: position.initialVolume.toString(),
    entryPrice: position.entryPrice.toString(),
    currentPrice: position.currentPrice?.toString() ?? null,
    stopLoss: position.stopLoss?.toString() ?? null,
    takeProfit: position.takeProfit?.toString() ?? null,
    trailingStopDistance: position.trailingStopDistance?.toString() ?? null,
    highWaterPrice: position.highWaterPrice?.toString() ?? null,
    margin: position.margin.toString(),
    commission: position.commission.toString(),
    swap: position.swap.toString(),
    realizedPnl: position.realizedPnl.toString(),
    /**
     * Price P&L at the current mark, before costs. `null` for a closed
     * position, and for an open one whose instrument has no fresh quote —
     * never `'0'`, because a trader cannot tell a genuine flat from a missing
     * price, and one of those is a reason to act.
     */
    floatingPnl: valuation?.floatingPnl?.toString() ?? null,
    /** True when no fresh price existed, so the mark above is not current. */
    stale: valuation?.stale ?? null,
    /**
     * Floating P&L less the costs already charged against this position.
     *
     * Deliberately not an estimate of the round trip — the exit commission
     * has not been charged, and inventing it would put a number on screen no
     * ledger entry will ever match.
     */
    netFloatingPnl: valuation?.netPnl?.toString() ?? null,
    closeReason: position.closeReason,
    openedAt: position.openedAt.toISOString(),
    closedAt: position.closedAt?.toISOString() ?? null,
  };
}
