'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  useRealtime,
  type AccountState,
  type Bar,
  type LivePnl,
  type Quote,
  type RiskUpdate,
} from './realtime-store';
import { useToasts } from './toasts';

const WS_URL = process.env['NEXT_PUBLIC_WS_URL'] ?? 'http://localhost:4000';

interface Frame {
  event: string;
  /** Identifies the occurrence. Two frames sharing one describe one thing. */
  eventId: string;
  channel: string;
  accountId: string | null;
  data: Record<string, unknown>;
  seq: number;
  timestamp: number;
}

/**
 * `orders` was missing from this list, which made the three `order.*` cases in
 * the frame handler unreachable — an order filling refreshed the tables only
 * because the *position* event fired alongside it. A limit order that fills
 * without opening a position, or an order rejected by risk, produced nothing.
 */
const CHANNELS = ['quotes', 'orders', 'positions', 'account', 'pnl'] as const;

/**
 * How many recently-seen event ids to remember for de-duplication.
 *
 * Small on purpose. A duplicate arrives within milliseconds of its original —
 * it is the same event taking a second path to the same socket — so a short
 * memory catches every realistic case, and an unbounded one would be a leak in
 * a process that stays open all day.
 */
const SEEN_EVENT_LIMIT = 256;

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

    /**
     * Event ids already applied, newest last.
     *
     * The server suppresses its own Redis echo, so a duplicate should not reach
     * here at all. This is the second line: a client that applied one fill twice
     * would refetch twice and, once notifications exist, alert twice. Cheap
     * insurance against a delivery path nobody has thought of yet.
     */
    const seen = new Set<string>();
    const seenOrder: string[] = [];

    socket.on('frame', (frame: Frame) => {
      const live = useRealtime.getState();

      // Sequence is noted before the duplicate check: `seq` is per-connection
      // and increments for every frame the server sent, duplicates included, so
      // skipping it here would manufacture a gap and force a needless
      // re-snapshot.
      live.noteSeq(frame.seq);

      if (typeof frame.eventId === 'string' && frame.eventId.length > 0) {
        if (seen.has(frame.eventId)) return;
        seen.add(frame.eventId);
        seenOrder.push(frame.eventId);
        if (seenOrder.length > SEEN_EVENT_LIMIT) {
          const oldest = seenOrder.shift();
          if (oldest !== undefined) seen.delete(oldest);
        }
      }

      switch (frame.event) {
        case 'quotes.updated':
          // Conflated: every instrument that moved since the last frame.
          for (const quote of frame.data as unknown as Quote[]) live.applyQuote(quote);
          break;
        case 'account.updated':
          live.applyAccount(frame.data as unknown as AccountState);
          break;
        case 'pnl.updated':
          // One frame per valuation, every open position in it.
          for (const pnl of frame.data as unknown as LivePnl[]) live.applyPnl(pnl);
          break;
        case 'candle.update':
          live.applyBar(frame.data as unknown as Bar);
          break;
        case 'order.filled':
          // A resting order placed minutes or hours ago has just become a
          // position. The submission that created it is matched on order id —
          // the command id belongs to the attempt, and nothing on this frame
          // carries it.
          if (typeof frame.data['orderId'] === 'string') {
            live.orderFilled(
              frame.data['orderId'],
              typeof frame.data['positionId'] === 'string' ? frame.data['positionId'] : null,
            );
          }
          notify.current();
          break;
        case 'order.rejected':
        case 'order.cancelled':
          // Cancelled, expired, or refused when it triggered. Whichever it was,
          // the order is not coming, and a command left reading "accepted"
          // would say the opposite.
          if (typeof frame.data['orderId'] === 'string') {
            live.orderClosed(
              frame.data['orderId'],
              typeof frame.data['reason'] === 'string' ? frame.data['reason'] : 'cancelled',
            );
          }
          notify.current();
          break;
        case 'position.created':
        case 'position.updated':
        case 'position.closed':
        case 'order.created':
        case 'order.updated':
          notify.current();
          break;
        case 'risk.updated': {
          // Transition-only by construction on the server, so this fires when
          // the account crosses a level and not while it sits at one.
          const risk = frame.data as unknown as RiskUpdate;
          live.applyRiskState(risk);
          raiseRiskToast(risk);
          break;
        }
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

/**
 * A margin call on screen, now.
 *
 * The server has also written a notification, which is the record; this is the
 * nudge, and the two are deliberately different things. A trader who is looking
 * gets told immediately; one who is away finds it in the bell when they return.
 *
 * The toast id is the account and the state, so an account oscillating across
 * its level updates one strip rather than stacking four. A stop-out is sticky:
 * it is the platform closing somebody's positions, and fading that away after
 * eight seconds would be deciding on their behalf that they had read it.
 */
function raiseRiskToast(risk: RiskUpdate): void {
  const toasts = useToasts.getState();
  const level = risk.marginLevel === null ? 'unknown' : `${risk.marginLevel}%`;

  if (risk.state === 'STOP_OUT') {
    toasts.push({
      id: `risk:${risk.accountId}`,
      tone: 'danger',
      sticky: true,
      title: 'Stop-out level reached',
      body: `Margin level ${level}, at or below the stop-out level of ${risk.stopOutLevelPercent ?? '—'}%. Positions may be closed automatically.`,
    });
    return;
  }

  if (risk.state === 'MARGIN_CALL') {
    toasts.push({
      id: `risk:${risk.accountId}`,
      tone: 'warning',
      sticky: false,
      title: 'Margin call',
      body: `Margin level ${level}, at or below ${risk.marginCallLevelPercent ?? '—'}%. Add funds or reduce exposure.`,
    });
    return;
  }

  // Back to normal. Worth saying once — and worth *replacing* the warning that
  // is still on screen, which is why it shares an id rather than being silent.
  if (risk.previous !== 'NORMAL') {
    toasts.push({
      id: `risk:${risk.accountId}`,
      tone: 'success',
      sticky: false,
      title: 'Margin level recovered',
      body: `Back above the margin-call level, at ${level}.`,
    });
  }
}
