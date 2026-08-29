import type { Socket } from 'socket.io';
import type { WsChannel } from '@tp/shared-types';

/**
 * Per-connection state.
 *
 * `seq` is the reason this exists: every frame a socket receives carries a
 * monotonically increasing number, so a client that sees a gap knows it missed
 * something and must re-snapshot over REST. Without it a dropped frame leaves a
 * P&L on screen that is quietly wrong and stays wrong.
 */
export interface SocketState {
  userId: string | null;
  /** Accounts this socket is allowed to receive private frames for. */
  accountIds: Set<string>;
  channels: Set<WsChannel>;
  /** Symbols this socket wants quotes for. Empty means every symbol. */
  symbols: Set<string>;
  /**
   * Symbols and resolutions this socket wants candles for.
   *
   * Kept apart from `symbols` because the two subscriptions are independent: a
   * terminal streams every quote for its watchlist while charting exactly one
   * instrument, and folding them together would silently narrow the watchlist to
   * whatever the chart happens to be showing.
   *
   * Unlike `symbols`, empty means *none*. Six resolutions per symbol on every
   * tick is a firehose nobody asked for, so a candle subscription names what it
   * wants or takes the default.
   */
  candleSymbols: Set<string>;
  resolutions: Set<string>;
  seq: number;
  /**
   * Resolves once `handleConnection` has finished resolving this socket's
   * identity, whether it succeeded or failed.
   *
   * Socket.IO delivers the client's `connect` event before that work is done, so
   * a terminal subscribing on `connect` — which every one does — would otherwise
   * race it and be refused its own private channels.
   */
  authenticated: Promise<void>;
}

export type TradingSocket = Socket & { state: SocketState };

export function initialState(): SocketState {
  return {
    userId: null,
    accountIds: new Set(),
    channels: new Set(),
    symbols: new Set(),
    candleSymbols: new Set(),
    resolutions: new Set(),
    seq: 0,
    // Replaced by handleConnection before any message can arrive. Resolved here
    // so a socket that somehow skips it cannot hang a subscribe forever.
    authenticated: Promise.resolve(),
  };
}
