import { io, type Socket } from 'socket.io-client';
import { WsChannel, type WsChannel as Channel, type WsFrame } from '@tp/shared-types';
import type { SeenEvents } from './seen-events';

/**
 * The live feed.
 *
 * Replaces what would otherwise be a poll loop — and the repository's own lint
 * rule forbids one, correctly: a `setInterval` refetching quotes is a fixed
 * cost per client per second whether or not anything moved, and it arrives late
 * by up to the interval on the one tick that mattered.
 *
 * ## Frames, not requests
 *
 * The server pushes an envelope carrying `seq` (per connection, monotonic) and
 * `eventId` (per occurrence). A gap in `seq` means a frame was missed and the
 * client must re-snapshot over REST; a repeated `eventId` means the same thing
 * arrived twice and the second must be discarded.
 *
 * Both are needed and they are not the same check. `seq` counts every frame the
 * server *sent*, duplicates included, so it is noted before the duplicate check
 * — otherwise discarding a duplicate would manufacture a gap and force a
 * pointless re-snapshot.
 */
/**
 * The envelope, as the server defines it. This was a local interface that
 * named the frame's time `at`; the server sends `timestamp`, and has since
 * the socket was written.
 */
export type Frame = WsFrame;

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

export interface RealtimeHandlers {
  onFrame(frame: Frame): void;
  onStatus(status: ConnectionStatus): void;
  /**
   * Called after every (re)connect.
   *
   * Whatever happened while disconnected was never delivered, so the screens
   * refetch. A client that reconnects and carries on from stale state shows a
   * P&L that is quietly wrong and stays wrong.
   */
  onResnapshot(): void;
}

const CHANNELS: readonly Channel[] = [
  WsChannel.QUOTES,
  WsChannel.ORDERS,
  WsChannel.POSITIONS,
  WsChannel.ACCOUNT,
  WsChannel.PNL,
];

export class RealtimeClient {
  private socket: Socket | null = null;
  private lastSeq: number | null = null;

  constructor(
    private readonly url: string,
    private readonly seen: SeenEvents,
  ) {}

  connect(token: string, handlers: RealtimeHandlers): void {
    this.disconnect();
    handlers.onStatus('connecting');

    const socket = io(this.url, {
      path: '/ws',
      // `websocket` only. Long-polling on a phone means a request every few
      // seconds over a mobile radio, which is the battery cost §42 asks to
      // avoid, and it is the transport a poll loop was supposed to replace.
      transports: ['websocket'],
      auth: { token },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      // A reconnect is a new connection with a new sequence origin.
      this.lastSeq = null;
      handlers.onStatus('live');
      for (const channel of CHANNELS) socket.emit('subscribe', { channel });
      handlers.onResnapshot();
    });

    socket.on('disconnect', () => handlers.onStatus('reconnecting'));
    socket.on('connect_error', () => handlers.onStatus('reconnecting'));

    socket.on('frame', (frame: Frame) => {
      // Noted first, and deliberately: `seq` counts frames sent, duplicates
      // included, so skipping it for a duplicate would invent a gap.
      const gap =
        this.lastSeq !== null && frame.seq > this.lastSeq + 1 ? frame.seq - this.lastSeq - 1 : 0;
      this.lastSeq = frame.seq;
      if (gap > 0) handlers.onResnapshot();

      if (typeof frame.eventId === 'string' && frame.eventId.length > 0) {
        // The same memory the push path uses, so a fill that arrives by both
        // routes is handled once between them rather than once each.
        if (!this.seen.claim(frame.eventId)) return;
      }

      handlers.onFrame(frame);
    });
  }

  /** Follows the chart or watchlist. Replaces rather than accumulating. */
  watch(symbols: readonly string[]): void {
    this.socket?.emit('subscribe', { channel: WsChannel.QUOTES, symbols });
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.lastSeq = null;
  }

  get connected(): boolean {
    return this.socket?.connected === true;
  }
}
