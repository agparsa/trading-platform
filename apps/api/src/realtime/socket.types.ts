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
  seq: number;
}

export type TradingSocket = Socket & { state: SocketState };

export function initialState(): SocketState {
  return {
    userId: null,
    accountIds: new Set(),
    channels: new Set(),
    symbols: new Set(),
    seq: 0,
  };
}
