'use client';

import { create } from 'zustand';

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
  openPositions: number;
  updatedAt: number;
}

export interface LivePnl {
  positionId: string;
  symbol: string;
  floatingPnl: string;
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

  applyAccount: (account) => set({ account }),

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
  resetConnection: () => set({ lastSeq: 0, gapDetected: false, pnl: {}, bars: {} }),
}));
