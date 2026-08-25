'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@tp/api-client';
import { barWindow, RESOLUTION_MINUTES } from './datafeed';
import { useSession } from './session';

/**
 * REST snapshots.
 *
 * The socket says *that* something changed; these queries say *what* the state
 * is. Lists are never assembled from frames — a client that missed a frame would
 * then be quietly wrong about which positions it holds, which is the one thing a
 * terminal may not be. Every mutation and every socket notification invalidates
 * the affected snapshot instead.
 *
 * There is deliberately no refetch interval. Polling is not the update
 * mechanism here; the socket is.
 */

export interface PositionRow {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: string;
  volume: string;
  initialVolume: string;
  entryPrice: string;
  currentPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  trailingStopDistance: string | null;
  highWaterPrice: string | null;
  margin: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  closeReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface TradeRow {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  exitPrice: string;
  entryTime: string;
  exitTime: string;
  grossPnl: string;
  /** Opening-leg commission apportioned to this closed volume. */
  entryCommission: string;
  /** Closing-leg commission. */
  exitCommission: string;
  /** The round trip's total: entry + exit. */
  commission: string;
  swap: string;
  /** grossPnl - commission + swap. Reconciles with the balance change. */
  netPnl: string;
  closeReason: string | null;
}

export interface OrderRow {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  status: string;
  volume: string;
  filledVolume: string;
  positionId: string | null;
  createdAt: string;
}

export interface SymbolRow {
  code: string;
  description: string;
  quoteCurrency: string;
  contractSize: string;
  tickSize: string;
  pricePrecision: number;
  volumeStep: string;
  volumePrecision: number;
  minVolume: string;
  maxVolume: string;
  marginRate: string;
  commissionPerLot: string;
  swapLongPerLot: string;
  swapShortPerLot: string;
  enabled: boolean;
  sessionOpen: boolean;
}

export interface SessionWindow {
  /** 0 = Sunday .. 6 = Saturday. */
  day: number;
  openMinute: number;
  closeMinute: number;
}

export interface TradingSession {
  symbol: string;
  /** IANA zone the windows are expressed in. */
  timezone: string;
  windows: SessionWindow[];
}

/** One instrument with its trading session, from `GET /symbols/:code`. */
export interface SymbolDetail extends SymbolRow {
  session: TradingSession;
}

export interface AccountSummary {
  id: string;
  number: string;
  type: string;
  status: string;
  currency: string;
  balance: string;
  leverage: number;
  createdAt: string;
}

export interface AccountStateResponse {
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
  positions: Array<{
    positionId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: string;
    entryPrice: string;
    currentPrice: string | null;
    floatingPnl: string;
    margin: string;
    stale: boolean;
  }>;
}

export interface QuoteRow {
  symbol: string;
  bid: string;
  ask: string;
  spread: string;
  timestamp: number;
}

export const queryKeys = {
  symbols: ['symbols'] as const,
  quotes: ['quotes'] as const,
  accounts: ['accounts'] as const,
  accountState: (accountId: string) => ['account-state', accountId] as const,
  positions: (accountId: string, includeClosed: boolean) =>
    ['positions', accountId, includeClosed] as const,
  trades: (accountId: string) => ['trades', accountId] as const,
  orders: (accountId: string) => ['orders', accountId] as const,
};

/** Everything a trading event can invalidate, in one place. */
export function invalidateTradingState(client: QueryClient, accountId: string): void {
  void client.invalidateQueries({ queryKey: ['positions', accountId] });
  void client.invalidateQueries({ queryKey: queryKeys.trades(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.orders(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.accountState(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.accounts });
}

export function useSymbols() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.symbols,
    queryFn: () => api.get<SymbolRow[]>('/symbols'),
    enabled: accessToken !== null,
    // Contract specifications change when an administrator edits them, which is
    // not a per-tick event. Refetching them on every trade would be noise.
    staleTime: 5 * 60_000,
  });
}

/**
 * One snapshot of every quote, so the watchlist has prices before the first
 * tick arrives. After that the socket carries them.
 */
/**
 * One instrument in full, including its session.
 *
 * The list endpoint omits session windows — it is read on every terminal load
 * and most callers do not need them. The chart does, so it asks for the one
 * instrument it is showing.
 */
export function useSymbolDetail(code: string | null) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['symbol', code ?? 'none'],
    queryFn: () => api.get<SymbolDetail>(`/symbols/${code ?? ''}`),
    enabled: code !== null && accessToken !== null,
    staleTime: 5 * 60_000,
  });
}

export function useQuoteSnapshot() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.quotes,
    queryFn: () => api.get<QuoteRow[]>('/market/quotes'),
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
}

export function useAccounts() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => api.get<AccountSummary[]>('/accounts'),
    enabled: accessToken !== null,
  });
}

export function useAccountState(accountId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.accountState(accountId ?? 'none'),
    queryFn: () => api.get<AccountStateResponse>(`/accounts/${accountId ?? ''}/state`),
    enabled: accountId !== null,
  });
}

export function usePositions(accountId: string | null, includeClosed = false) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.positions(accountId ?? 'none', includeClosed),
    queryFn: () =>
      api.get<PositionRow[]>('/positions', {
        query: { accountId: accountId ?? '', includeClosed: String(includeClosed), limit: 200 },
      }),
    enabled: accountId !== null,
  });
}

export function useTrades(accountId: string | null, enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.trades(accountId ?? 'none'),
    queryFn: () =>
      api.get<TradeRow[]>('/trades', { query: { accountId: accountId ?? '', limit: 200 } }),
    enabled: accountId !== null && enabled,
  });
}

export function useOrders(accountId: string | null, enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.orders(accountId ?? 'none'),
    queryFn: () =>
      api.get<OrderRow[]>('/orders', { query: { accountId: accountId ?? '', limit: 200 } }),
    enabled: accountId !== null && enabled,
  });
}

export interface OpenPositionInput {
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  stopLoss: string | null;
  takeProfit: string | null;
}

/**
 * Every mutation carries a fresh idempotency key.
 *
 * The key is minted once per attempt, not per retry: a network failure that the
 * client retries must not be able to open a second position. `ApiClient` refuses
 * to send a mutation without one.
 */
function mutate<TInput, TResult>(
  api: ApiClient,
  run: (api: ApiClient, input: TInput, key: string) => Promise<TResult>,
) {
  return (input: TInput) => run(api, input, crypto.randomUUID());
}

export function useOpenPosition(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<OpenPositionInput, unknown>(api, (client_, input, key) =>
      client_.post('/orders', input, { idempotencyKey: key }),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export function useClosePosition(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<{ positionId: string; volume: string | null }, unknown>(
      api,
      (client_, input, key) =>
        client_.post(
          `/positions/${input.positionId}/close`,
          input.volume === null ? {} : { volume: input.volume },
          { idempotencyKey: key },
        ),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export interface ModifyInput {
  positionId: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
  trailingStopDistance?: string | null;
}

export function useModifyPosition(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<ModifyInput, unknown>(api, (client_, input, key) => {
      const { positionId, ...body } = input;
      return client_.patch(`/positions/${positionId}`, body, { idempotencyKey: key });
    }),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export function useReversePosition(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<{ positionId: string }, unknown>(api, (client_, input, key) =>
      client_.post(`/positions/${input.positionId}/reverse`, {}, { idempotencyKey: key }),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export interface AccountSettings {
  marginCallLevelPercent: string;
  stopOutLevelPercent: string;
  maxPositionVolume: string | null;
  maxOpenPositions: number | null;
  maxGrossNotional: string | null;
  maxSymbolNetVolume: string | null;
}

/**
 * Risk thresholds for the account.
 *
 * The terminal reads these to colour the margin level, never to enforce
 * anything: the stop-out decision belongs to the server, and a browser that
 * disagrees is simply wrong on screen rather than dangerous.
 */
export function useAccountSettings(accountId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: ['account-settings', accountId ?? 'none'],
    queryFn: () => api.get<AccountSettings>(`/accounts/${accountId ?? ''}/settings`),
    enabled: accountId !== null,
    staleTime: 5 * 60_000,
  });
}

export interface CandleRow {
  symbol: string;
  resolution: string;
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Historical bars for one instrument.
 *
 * `from`/`to` are rounded to the bar boundary rather than taken from the wall
 * clock, so the query key changes once per bar instead of on every render —
 * otherwise React Query would treat each render as a new query and refetch the
 * whole series continuously.
 */
export function useCandles(symbol: string | null, resolution: string, bars = 400) {
  const { api } = useSession();
  const { fromMs, toMs } = barWindow(resolution, bars, Date.now());

  return useQuery({
    queryKey: ['candles', symbol ?? 'none', resolution, fromMs],
    queryFn: () =>
      api.get<CandleRow[]>('/market/candles', {
        query: { symbol: symbol ?? '', resolution, from: fromMs, to: toMs },
      }),
    enabled: symbol !== null,
    // The in-progress bar arrives over the socket; this series only needs
    // refetching when the window itself moves on.
    staleTime: (RESOLUTION_MINUTES[resolution] ?? 1) * 60_000,
  });
}
