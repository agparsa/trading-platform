'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  useRealtime,
  type AccountState,
  type Bar,
  type LivePnl,
  type Quote,
} from './realtime-store';

const WS_URL = process.env['NEXT_PUBLIC_WS_URL'] ?? 'http://localhost:4000';

interface Frame {
  event: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: number;
}

const CHANNELS = ['quotes', 'positions', 'account', 'pnl'] as const;

/**
 * Holds one socket open for the life of the terminal.
 *
 * `onTradingEvent` fires when the server reports something that changes the
 * order or position tables, so the caller can refetch those snapshots. The
 * socket carries the *notification*; REST remains the source of the list. That
 * split means a missed frame degrades to a stale list rather than a list built
 * from frames the client happened to catch.
 *
 * Store access goes through `useRealtime.getState()` rather than the hook. The
 * hook form subscribes the calling component to every field, so a quote arriving
 * four times a second would re-render the whole terminal — including the order
 * ticket a trader is typing into. Writes still notify the components that
 * actually select the changed slice.
 */
export function useSocket(
  token: string | null,
  onTradingEvent: () => void,
  chartSymbol: string | null = null,
  chartResolution = '1',
): void {
  const socketRef = useRef<Socket | null>(null);
  // Scalars rather than an object, so a caller that builds the pair inline does
  // not re-subscribe on every render.
  const chartRef = useRef({ symbol: chartSymbol, resolution: chartResolution });
  chartRef.current = { symbol: chartSymbol, resolution: chartResolution };
  // Kept in a ref so changing the callback does not tear the socket down.
  const notify = useRef(onTradingEvent);
  notify.current = onTradingEvent;

  useEffect(() => {
    const store = useRealtime.getState();

    if (token === null) {
      socketRef.current?.close();
      socketRef.current = null;
      store.setStatus('idle');
      return;
    }

    store.setStatus('connecting');
    store.resetConnection();

    const socket = io(WS_URL, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      // A reconnect is a new connection with a new sequence origin.
      useRealtime.getState().resetConnection();
      useRealtime.getState().setStatus('live');
      for (const channel of CHANNELS) socket.emit('subscribe', { channel });
      const wanted = chartRef.current;
      if (wanted.symbol !== null) {
        socket.emit('subscribe', {
          channel: 'candles',
          symbols: [wanted.symbol],
          resolutions: [wanted.resolution],
        });
      }
      // Whatever happened while disconnected was never delivered, so re-snapshot.
      notify.current();
    });

    socket.on('disconnect', () => useRealtime.getState().setStatus('reconnecting'));
    socket.on('connect_error', () => useRealtime.getState().setStatus('reconnecting'));

    socket.on('frame', (frame: Frame) => {
      const live = useRealtime.getState();
      live.noteSeq(frame.seq);

      switch (frame.event) {
        case 'quote.update':
          live.applyQuote(frame.data as unknown as Quote);
          break;
        case 'account.updated':
          live.applyAccount(frame.data as unknown as AccountState);
          break;
        case 'pnl.updated':
          live.applyPnl(frame.data as unknown as LivePnl);
          break;
        case 'candle.update':
          live.applyBar(frame.data as unknown as Bar);
          break;
        case 'position.created':
        case 'position.updated':
        case 'position.closed':
        case 'order.filled':
        case 'order.updated':
        case 'order.cancelled':
          notify.current();
          break;
        default:
          break;
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
      useRealtime.getState().setStatus('idle');
    };
  }, [token]);

  // Changing instrument or resolution re-subscribes on the open socket rather
  // than reconnecting: a reconnect would restart the sequence and re-snapshot
  // everything, for a change that only concerns the chart.
  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null || !socket.connected) return;
    useRealtime.getState().clearBars();
    if (chartSymbol === null) {
      socket.emit('unsubscribe', { channel: 'candles' });
      return;
    }
    socket.emit('subscribe', {
      channel: 'candles',
      symbols: [chartSymbol],
      resolutions: [chartResolution],
    });
  }, [chartSymbol, chartResolution]);
}
