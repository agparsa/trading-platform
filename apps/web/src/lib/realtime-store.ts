'use client';

import { create } from 'zustand';
import {
  beginCommand,
  noteOrderClosed,
  noteOrderFilled,
  settleCommand,
  type CommandSettlement,
  type NewCommand,
  type OrderCommand,
} from './order-commands';

export interface Quote {
  symbol: string;
  bid: string;
  ask: string;
  spread: string;
  timestamp: number;
  /** Previous bid, so the watchlist can flash direction without inventing data. */
  previousBid?: string;
}

export interface AccountState {
  accountId: string;
  currency: string;
  balance: string;
  equity: string;
  floatingPnl: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  marginUtilisation: string | null;
  grossExposure: string;
  /**
   * Realized P&L, which arrives with the REST snapshot and not with tick
   * frames — nothing about it changes on a tick, so paying for it 2× a second
   * would buy nothing. Optional here for exactly that reason, and the store
   * carries it forward rather than letting a frame erase it.
   */
  realizedPnlToday?: string;
  realizedPnlTotal?: string;
  realizedSince?: number;
  openPositions: number;
  updatedAt: number;
}

export interface LivePnl {
  positionId: string;
  symbol: string;
  floatingPnl: string;
  /** Mark less the costs already charged. Computed by the server, never here. */
  netPnl: string;
  currentPrice: string | null;
  stale: boolean;
}

export interface Bar {
  symbol: string;
  resolution: string;
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** True when this is the final state of a bucket that has closed. */
  closed?: boolean;
}

/**
 * How close the account is to the levels that stop it trading.
 *
 * Sent by the server on *transition only* — the account crossing into or out of
 * a state — so this is set once when it happens, not repeatedly while it holds.
 */
export interface RiskUpdate {
  accountId: string;
  state: 'NORMAL' | 'MARGIN_CALL' | 'STOP_OUT';
  previous: 'NORMAL' | 'MARGIN_CALL' | 'STOP_OUT';
  marginLevel: string | null;
  marginCallLevelPercent: string | null;
  stopOutLevelPercent: string | null;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

/** How many live bars to keep per chart before the REST history takes over. */
const LIVE_BAR_WINDOW = 32;

export function barKey(symbol: string, resolution: string): string {
  return `${symbol}:${resolution}`;
}

interface RealtimeState {
  status: ConnectionStatus;
  quotes: Record<string, Quote>;
  account: AccountState | null;
  /** The last risk transition announced, or null while the account is normal. */
  risk: RiskUpdate | null;
  /**
   * What became of the orders this browser submitted, newest first.
   *
   * Lives here rather than in the ticket because two things write to it — the
   * ticket when it sends, the socket when a resting order later fills — and one
   * of them is not a React component. It is never a source of truth about
   * positions; the tables are. See lib/order-commands.ts.
   */
  commands: OrderCommand[];
  pnl: Record<string, LivePnl>;
  /**
   * Bars that arrived over the socket, keyed by `symbol:resolution` and then by
   * bar time. The chart merges these over its REST history; REST still owns the
   * series, so a dropped frame leaves one bar briefly behind rather than a hole
   * in the chart.
   */
  bars: Record<string, Record<number, Bar>>;
  /** Last sequence number seen on this connection. */
  lastSeq: number;
  /** Set when a gap proves frames were missed. Cleared once a re-snapshot lands. */
  gapDetected: boolean;
  framesReceived: number;

  setStatus: (status: ConnectionStatus) => void;
  applyQuote: (quote: Quote) => void;
  applyAccount: (account: AccountState) => void;
  applyRiskState: (risk: RiskUpdate) => void;
  startCommand: (command: NewCommand) => void;
  settleCommand: (commandId: string, settlement: CommandSettlement) => void;
  orderFilled: (orderId: string, positionId: string | null) => void;
  orderClosed: (orderId: string, reason: string) => void;
  applyPnl: (pnl: LivePnl) => void;
  applyBar: (bar: Bar) => void;
  clearBars: () => void;
  noteSeq: (seq: number) => void;
  clearGap: () => void;
  resetConnection: () => void;
}

export const useRealtime = create<RealtimeState>((set) => ({
  status: 'idle',
  quotes: {},
  account: null,
  risk: null,
  commands: [],
  pnl: {},
  bars: {},
  lastSeq: 0,
  gapDetected: false,
  framesReceived: 0,

  setStatus: (status) => set({ status }),

  applyQuote: (quote) =>
    set((state) => {
      const existing = state.quotes[quote.symbol];
      return {
        quotes: {
          ...state.quotes,
          [quote.symbol]: {
            ...quote,
            ...(existing === undefined ? {} : { previousBid: existing.bid }),
          },
        },
      };
    }),

  /**
   * A frame replaces the account state, except for the realized figures, which
   * it carries forward when the frame does not name them.
   *
   * Absent and zero are different claims. A tick frame says nothing about
   * realized P&L; treating its silence as "zero" would flash the number to
   * nothing twice a second between snapshots, and a trader would reasonably
   * believe their day's profit had been wiped.
   */
  applyAccount: (incoming) =>
    set((state) => {
      const previous = state.account;
      const sameAccount = previous !== null && previous.accountId === incoming.accountId;
      if (!sameAccount || incoming.realizedPnlToday !== undefined) {
        return { account: incoming };
      }
      return {
        account: {
          ...incoming,
          ...(previous.realizedPnlToday === undefined
            ? {}
            : {
                realizedPnlToday: previous.realizedPnlToday,
                realizedPnlTotal: previous.realizedPnlTotal,
                realizedSince: previous.realizedSince,
              }),
        },
      };
    }),

  applyRiskState: (risk) => set({ risk }),

  startCommand: (command) => set((state) => ({ commands: beginCommand(state.commands, command) })),
  settleCommand: (commandId, settlement) =>
    set((state) => ({ commands: settleCommand(state.commands, commandId, settlement) })),
  orderFilled: (orderId, positionId) =>
    set((state) => ({
      commands: noteOrderFilled(state.commands, orderId, positionId, Date.now()),
    })),
  orderClosed: (orderId, reason) =>
    set((state) => ({ commands: noteOrderClosed(state.commands, orderId, reason, Date.now()) })),

  applyPnl: (pnl) => set((state) => ({ pnl: { ...state.pnl, [pnl.positionId]: pnl } })),

  applyBar: (bar) =>
    set((state) => {
      const key = barKey(bar.symbol, bar.resolution);
      const merged = { ...(state.bars[key] ?? {}), [bar.time]: bar };
      // Bounded: a terminal left open all day would otherwise accumulate every
      // bar it ever saw, and the chart only draws the recent window anyway.
      const times = Object.keys(merged)
        .map(Number)
        .sort((a, b) => b - a)
        .slice(0, LIVE_BAR_WINDOW);
      const trimmed: Record<number, Bar> = {};
      for (const time of times) {
        const value = merged[time];
        if (value !== undefined) trimmed[time] = value;
      }
      return { bars: { ...state.bars, [key]: trimmed } };
    }),

  clearBars: () => set({ bars: {} }),

  /**
   * Sequence numbers are per connection and gapless by contract. A gap means
   * frames were dropped, so anything on screen may be stale in a way the user
   * cannot see. The flag drives a full re-snapshot over REST rather than a
   * silent guess.
   */
  noteSeq: (seq) =>
    set((state) => ({
      lastSeq: seq,
      framesReceived: state.framesReceived + 1,
      gapDetected: state.gapDetected || (state.lastSeq !== 0 && seq !== state.lastSeq + 1),
    })),

  clearGap: () => set({ gapDetected: false }),

  // A new connection restarts the sequence at 1, so the old high-water mark
  // must go with it or the first frame would look like a gap.
  /**
   * A reconnect clears everything that was streamed, and deliberately keeps the
   * last risk transition.
   *
   * Sequence, live P&L and live bars are all per-connection and are re-derived
   * from the snapshot that follows. Two things are not, and both are kept.
   *
   * The risk state is the answer to "is this account in trouble". The server
   * only re-sends it when it *changes*, so dropping it here would clear a
   * stop-out warning off the screen because the socket blinked.
   *
   * The command log is what this browser submitted. A reconnect does not undo
   * an order, and a trader who loses their record of one at the moment the
   * connection wobbles is left with no way to tell whether it went.
   */
  resetConnection: () => set({ lastSeq: 0, gapDetected: false, pnl: {}, bars: {} }),
}));
