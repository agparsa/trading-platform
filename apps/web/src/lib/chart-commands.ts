'use client';

import { useMemo } from 'react';
import { LevelKind, modificationFor } from './chart-levels';
import { useCancelPending, useClosePosition, useModifyPending, useModifyPosition } from './queries';

/**
 * Everything a chart may ask the platform to do.
 *
 * ## Why this is an interface and not a pile of `useMutation` calls
 *
 * The renderer is not settled. `lightweight-charts` draws the terminal today;
 * TradingView Advanced Charts is licensed, absent from this repository, and
 * expects to be handed a *broker* object with its own method names when it
 * arrives. `lib/tradingview-datafeed.ts` already holds the reading half of that
 * seam — bars, symbols, sessions. This is the writing half.
 *
 * Both halves exist so that swapping the renderer is a change in `apps/web`
 * alone: no engine change, no API change, no WebSocket change. That was the
 * promise made in docs/charting.md and this is the second half of keeping it.
 *
 * ## What it deliberately does not do
 *
 * It does not validate. Snapping to the tick grid and refusing an illegal level
 * belong to `chart-levels.ts`, which is pure and tested; a command adapter that
 * also validated would be a second place for those rules to live and a second
 * place for them to drift.
 *
 * It does not report success either — every one of these resolves when the
 * server accepted the request, and what the trader sees changes when the
 * position query refetches and the socket frame lands. A chart that moved its
 * own line on `resolve` would be showing a value the server has not confirmed.
 */
export interface TradingCommandAdapter {
  /** Move a stop-loss or take-profit on an open position. */
  modifyPositionLevel(positionId: string, kind: LevelKind, price: string): Promise<void>;
  /** Move a resting order's trigger price. */
  movePendingOrder(orderId: string, price: string): Promise<void>;
  /** Close an open position, or part of one. `null` volume closes it all. */
  closePosition(positionId: string, volume: string | null): Promise<void>;
  /** Remove a resting order. */
  cancelPendingOrder(orderId: string): Promise<void>;
}

/**
 * The adapter, bound to one account's mutations.
 *
 * A hook rather than a factory because every one of these already invalidates
 * the right React Query keys on success — reimplementing that here would be a
 * second cache-invalidation policy, and the two would disagree the first time
 * one of them changed.
 */
export function useTradingCommands(accountId: string | null): TradingCommandAdapter {
  const modifyPosition = useModifyPosition(accountId);
  const modifyPending = useModifyPending(accountId);
  const close = useClosePosition(accountId);
  const cancel = useCancelPending(accountId);

  return useMemo<TradingCommandAdapter>(
    () => ({
      modifyPositionLevel: async (positionId, kind, price) => {
        if (kind !== LevelKind.STOP_LOSS && kind !== LevelKind.TAKE_PROFIT) {
          // The entry line is not a level anybody may move, and a pending
          // order's price is a different command. Silently doing nothing would
          // hide a wiring mistake; refusing names it.
          throw new Error(`${kind} is not a movable position level`);
        }
        await modifyPosition.mutateAsync({ positionId, ...modificationFor(kind, price) });
      },
      movePendingOrder: async (orderId, price) => {
        await modifyPending.mutateAsync({ orderId, price });
      },
      closePosition: async (positionId, volume) => {
        await close.mutateAsync({ positionId, volume });
      },
      cancelPendingOrder: async (orderId) => {
        await cancel.mutateAsync({ orderId });
      },
    }),
    [modifyPosition, modifyPending, close, cancel],
  );
}
