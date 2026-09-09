'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@tp/api-client';
import { barWindow, RESOLUTION_MINUTES } from '@tp/chart-core';
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
  /** Used margin as a share of equity. `null` when there is no equity to divide by. */
  marginUtilisation: string | null;
  /** Sum of absolute notional across open positions, in account currency. */
  grossExposure: string;
  /** Present on the REST snapshot only; tick frames omit it. See realtime-store. */
  realizedPnlToday?: string;
  realizedPnlTotal?: string;
  realizedSince?: number;
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
    commission: string;
    swap: string;
    netPnl: string;
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

export interface PendingOrderRow {
  orderId: string;
  status: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  volume: string;
  price: string;
  stopLoss: string | null;
  takeProfit: string | null;
  timeInForce: string;
  expiresAt: string | null;
  createdAt: string;
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
  pending: (accountId: string) => ['pending-orders', accountId] as const,
  permissions: ['permissions', 'me'] as const,
  wallets: ['wallets'] as const,
  walletTransactions: (walletId: string) => ['wallet-transactions', walletId] as const,
  payments: ['payments'] as const,
  paymentProviders: ['payment-providers'] as const,
  kyc: ['kyc'] as const,
  withdrawals: ['withdrawals'] as const,
  withdrawalTerms: (currency: string) => ['withdrawal-terms', currency] as const,
  apiKeys: ['api-keys'] as const,
  securityEvents: ['security-events'] as const,
  addresses: ['addresses'] as const,
};

/** Everything a trading event can invalidate, in one place. */
export function invalidateTradingState(client: QueryClient, accountId: string): void {
  void client.invalidateQueries({ queryKey: ['positions', accountId] });
  void client.invalidateQueries({ queryKey: queryKeys.trades(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.orders(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.pending(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.accountState(accountId) });
  void client.invalidateQueries({ queryKey: queryKeys.accounts });
}

/**
 * What this login may do, according to the server.
 *
 * Asked rather than computed. It used to be computed — `roleHasPermissions`
 * against the compile-time table, with a comment explaining that this was the
 * same table the server enforced with. That stopped being true the moment
 * grants became rows a tenant can edit, and the failure would have been silent
 * in the worse direction: a capability an administrator had *removed* would
 * still have had its button on screen, and the trader would have found out from
 * a refusal.
 *
 * Still only about what is offered. The server decides, on every call.
 */
export function usePermissions() {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.permissions,
    queryFn: () => api.get<{ role: string; permissions: string[] }>('/permissions/me'),
    // Grants change rarely and a stale answer only mis-offers a control the
    // server will still refuse, so this is worth caching for a while.
    staleTime: 5 * 60 * 1000,
  });
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

/**
 * How each instrument has moved today, from the server.
 *
 * Refetched on an interval, and this is the one place polling is right: the
 * reference is the previous *daily* close, so the figure changes when the price
 * changes — which the socket already reports — and when the day rolls, which
 * nothing reports. A minute is far finer than either.
 */
export interface MarketStatsRow {
  symbol: string;
  open: string | null;
  high: string | null;
  low: string | null;
  last: string | null;
  reference: string | null;
  referenceKind: 'PREVIOUS_CLOSE' | 'SESSION_OPEN' | 'NONE';
  change: string | null;
  changePercent: string | null;
}

export function useMarketStats() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['market-stats'],
    queryFn: () => api.get<MarketStatsRow[]>('/market/stats'),
    enabled: accessToken !== null,
    staleTime: 60_000,
    refetchInterval: 60_000,
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

/** Resting LIMIT and STOP orders that have not fired. */
export function usePendingOrders(accountId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.pending(accountId ?? 'none'),
    queryFn: () =>
      api.get<PendingOrderRow[]>('/orders/pending', { query: { accountId: accountId ?? '' } }),
    enabled: accountId !== null,
  });
}

export interface OpenPositionInput extends CommandInput {
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  stopLoss: string | null;
  takeProfit: string | null;
}

/**
 * Every mutation carries an idempotency key.
 *
 * The key is minted once per attempt, not per retry: a network failure that the
 * client retries must not be able to open a second position. `ApiClient` refuses
 * to send a mutation without one.
 *
 * A caller may supply the key instead, as `commandId`. That is not a second way
 * of doing the same thing: the order ticket needs to *know* the key so it can
 * record what became of the attempt, and minting one here and returning it
 * separately would leave a window in which the request had been sent and the
 * ticket did not yet know under which id. It is stripped from the body — it is
 * a header, and echoing it into the payload would make one attempt's request
 * differ from a retry's for no reason.
 */
export interface CommandInput {
  /** Idempotency key for this attempt. Minted here when omitted. */
  commandId?: string;
}

function mutate<TInput extends CommandInput, TResult>(
  api: ApiClient,
  run: (api: ApiClient, input: TInput, key: string) => Promise<TResult>,
) {
  return (input: TInput) => {
    const { commandId, ...body } = input;
    return run(api, body as unknown as TInput, commandId ?? crypto.randomUUID());
  };
}

/** What `POST /orders` answers with. A market order that filled names its position. */
export interface OrderAck {
  orderId: string;
  positionId?: string;
  status: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  price: string;
  executedAt?: string;
}

export function useOpenPosition(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<OpenPositionInput, OrderAck>(api, (client_, input, key) =>
      client_.post<OrderAck>('/orders', input, { idempotencyKey: key }),
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
    mutationFn: mutate<CommandInput & { positionId: string; volume: string | null }, unknown>(
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

export interface CloseAllOutcome {
  asked: number;
  closed: { positionId: string }[];
  /** Still open, each with the reason. Not atomic, and the shape says so. */
  refused: { positionId: string; code: string; message: string }[];
}

/**
 * Close everything on the account, as one server command.
 *
 * It used to be a loop here: one request per position, partial failure
 * swallowed by the browser. A dropped connection halfway through left the rest
 * open under a screen that said the button had been pressed, and the platform
 * had no record that "close everything" had ever been asked for.
 *
 * The command is deliberately not atomic — each close takes its own lock,
 * quote and ledger entry — so the caller reads `refused` rather than a boolean.
 */
export function useCloseAllPositions(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<CommandInput & { accountId: string }, CloseAllOutcome>(
      api,
      (client_, input, key) =>
        client_.post<CloseAllOutcome>(
          '/positions/close-all',
          { accountId: input.accountId },
          { idempotencyKey: key },
        ),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export interface ModifyInput extends CommandInput {
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
    mutationFn: mutate<CommandInput & { positionId: string }, unknown>(api, (client_, input, key) =>
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

export interface PlacePendingInput extends CommandInput {
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'STOP';
  volume: string;
  price: string;
  stopLoss: string | null;
  takeProfit: string | null;
  timeInForce: 'GTC' | 'DAY' | 'GTD';
}

export function usePlacePending(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<PlacePendingInput, PendingOrderRow>(api, (client_, input, key) =>
      client_.post<PendingOrderRow>('/orders/pending', input, { idempotencyKey: key }),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export function useCancelPending(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<CommandInput & { orderId: string }, unknown>(api, (client_, input, key) =>
      client_.delete(`/orders/${input.orderId}`, { idempotencyKey: key }),
    ),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

export interface ModifyPendingInput extends CommandInput {
  orderId: string;
  price?: string;
  volume?: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
}

export function useModifyPending(accountId: string | null) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: mutate<ModifyPendingInput, unknown>(api, (client_, input, key) => {
      const { orderId, ...body } = input;
      return client_.patch(`/orders/${orderId}`, body, { idempotencyKey: key });
    }),
    onSuccess: () => {
      if (accountId !== null) invalidateTradingState(client, accountId);
    },
  });
}

// ─── Notifications ─────────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string;
  data: unknown;
  accountId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * The notices the server has written for this user.
 *
 * Polled slowly rather than pushed, and only while the panel is open. A
 * notification is *already* the durable record — it was written precisely so it
 * would survive the browser being shut — so there is nothing for a socket frame
 * to add except a second delivery path to keep in step with the first.
 *
 * The one push that matters, a risk transition, arrives on the socket anyway and
 * raises a toast; this is what the trader reads afterwards.
 */
export function useNotifications(enabled = true) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationRow[]>('/notifications', { query: { limit: 50 } }),
    enabled: accessToken !== null && enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
  });
}

export function useMarkRead() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      api.post(`/notifications/${input.id}/read`, {}, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllRead() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post('/notifications/read-all', {}, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export interface WalletRow {
  id: string;
  currency: string;
  balance: string;
  status: string;
}

export interface WalletTransactionRow {
  id: string;
  type: string;
  amount: string;
  balanceAfter: string;
  currency: string;
  accountId: string | null;
  description: string | null;
  createdAt: string;
}

export function useWallets() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.wallets,
    queryFn: () => api.get<{ wallets: WalletRow[] }>('/wallet'),
    enabled: accessToken !== null,
  });
}

export function useWalletTransactions(walletId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: queryKeys.walletTransactions(walletId ?? 'none'),
    queryFn: () =>
      api.get<{ transactions: WalletTransactionRow[] }>(`/wallet/${walletId ?? ''}/transactions`),
    enabled: walletId !== null,
  });
}

/**
 * Moves money between a wallet and a trading account.
 *
 * No currency in the request. The amount is in the account's currency, because
 * both pots are — see the endpoint. Every snapshot that could have changed is
 * invalidated: the wallet, its movements, the account list and that account's
 * state, because a transfer changes the balance and therefore the free margin
 * the ticket is about to size an order against.
 */
export function useWalletTransfer() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: string;
      direction: 'to-account' | 'to-wallet';
      amount: string;
    }) =>
      api.post<{ wallet: WalletRow; accountBalance: string }>('/wallet/transfer', input, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: queryKeys.wallets });
      void client.invalidateQueries({ queryKey: ['wallet-transactions'] });
      void client.invalidateQueries({ queryKey: queryKeys.accounts });
      void client.invalidateQueries({ queryKey: queryKeys.accountState(input.accountId) });
    },
  });
}

export interface PaymentRow {
  id: string;
  provider: string;
  amount: string;
  currency: string;
  status: string;
  instructions: string | null;
  failureReason: string | null;
  expiresAt: string;
  settledAt: string | null;
  createdAt: string;
}

/**
 * What this deployment can take money through.
 *
 * Asked of the server rather than written down here. A client that offered a
 * provider the server does not have would produce a form that fails on submit,
 * and a deployment with only the manual bank transfer should say so plainly
 * rather than showing card logos nothing behind them can charge.
 */
export function usePaymentProviders() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.paymentProviders,
    queryFn: () => api.get<{ providers: string[] }>('/payments/providers'),
    enabled: accessToken !== null,
    staleTime: 5 * 60 * 1000,
  });
}

export function usePayments() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.payments,
    queryFn: () => api.get<{ payments: PaymentRow[] }>('/payments'),
    enabled: accessToken !== null,
  });
}

/**
 * Starts a deposit.
 *
 * Deliberately does **not** invalidate the wallet. Starting a payment moves no
 * money — the balance changes when the provider says it has the funds, or when
 * somebody here matches a bank transfer — and refetching the wallet on submit
 * would suggest a screen where a number was about to go up.
 */
export function useStartPayment() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: string; amount: string; currency: string }) =>
      api.post<PaymentRow>('/payments', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.payments });
    },
  });
}

export interface KycDocumentRow {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  filename: string | null;
  uploadedAt: string;
  purged: boolean;
  current: boolean;
}

export interface KycView {
  status: string;
  reason: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  verified: boolean;
  canSubmit: boolean;
  missing: string[];
  documents: KycDocumentRow[];
}

export function useKyc() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.kyc,
    queryFn: () => api.get<KycView>('/kyc'),
    enabled: accessToken !== null,
  });
}

/**
 * Uploads one document as bytes.
 *
 * The file goes up as itself, under its own type. What the server records is
 * what the bytes turn out to be, not what the browser called them — so a file
 * the server refuses is refused with a reason, not stored under a wrong label.
 */
export function useUploadKycDocument() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, file }: { kind: string; file: File }) =>
      api.putBytes<KycDocumentRow>(`/kyc/documents/${kind}`, file, {
        contentType: file.type,
        filename: file.name,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.kyc });
    },
  });
}

export function useSubmitKyc() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<KycView>('/kyc/submit', {}, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.kyc });
    },
  });
}

export interface WithdrawalRow {
  id: string;
  walletId: string;
  amount: string;
  currency: string;
  status: string;
  destinationHint: string;
  reason: string | null;
  providerReference: string | null;
  canCancel: boolean;
  createdAt: string;
  approvedAt: string | null;
  decidedAt: string | null;
}

export interface WithdrawalTerms {
  minimum: string;
  maximum: string;
  dailyLimit: string | null;
  remainingToday: string | null;
  cooldownHours: number;
  nextAllowedAt: string | null;
  identityRequired: boolean;
  identityVerified: boolean;
}

export function useWithdrawalTerms(currency: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.withdrawalTerms(currency),
    queryFn: () => api.get<WithdrawalTerms>('/withdrawals/terms', { query: { currency } }),
    enabled: accessToken !== null,
  });
}

export function useWithdrawals() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.withdrawals,
    queryFn: () => api.get<{ withdrawals: WithdrawalRow[] }>('/withdrawals'),
    enabled: accessToken !== null,
  });
}

/**
 * Asks for money out. The wallet is debited the moment this succeeds, so the
 * wallet and its movements are refetched — the balance the person sees must be
 * what they can still use, not what they had before asking.
 */
export function useRequestWithdrawal() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { walletId: string; amount: string; destination: string }) =>
      api.post<WithdrawalRow>('/withdrawals', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.withdrawals });
      void client.invalidateQueries({ queryKey: ['withdrawal-terms'] });
      void client.invalidateQueries({ queryKey: queryKeys.wallets });
      void client.invalidateQueries({ queryKey: ['wallet-transactions'] });
    },
  });
}

export function useCancelWithdrawal() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<WithdrawalRow>(
        `/withdrawals/${id}/cancel`,
        {},
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.withdrawals });
      void client.invalidateQueries({ queryKey: ['withdrawal-terms'] });
      void client.invalidateQueries({ queryKey: queryKeys.wallets });
      void client.invalidateQueries({ queryKey: ['wallet-transactions'] });
    },
  });
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  name: string;
  fingerprint: string;
  permissions: string[];
  rateLimitPerMinute: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  usage7d: { requests: number; refused: number; throttled: number };
}

export function useApiKeys() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: () => api.get<{ keys: ApiKeyRow[] }>('/api-keys'),
    enabled: accessToken !== null,
  });
}

/**
 * Mints a key. The response is the only time the secret exists on this side
 * of the wire; the caller shows it once and keeps it in component state, never
 * in the query cache, so a later refetch cannot bring it back.
 */
export function useMintApiKey() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      permissions: string[];
      expiresInDays?: number;
      rateLimitPerMinute?: number;
      password: string;
    }) =>
      api.post<{ key: ApiKeyRow; token: string }>('/api-keys', input, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKey() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<ApiKeyRow>(`/api-keys/${id}/revoke`, reason === undefined ? {} : { reason }, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ---- Security feed --------------------------------------------------------

export interface SecurityEventRow {
  id: string;
  kind: string;
  severity: 'INFO' | 'NOTICE' | 'WARNING';
  at: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  /** Somebody other than you did it: staff, or the platform. */
  byOther: boolean;
  details: Record<string, unknown> | null;
}

/** What has happened to your own account, newest first. */
export function useSecurityEvents(limit = 50) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: [...queryKeys.securityEvents, limit] as const,
    queryFn: () => api.get<{ events: SecurityEventRow[] }>(`/security/events?limit=${limit}`),
    enabled: accessToken !== null,
    refetchInterval: 60_000,
  });
}

export interface AddressRow {
  ipAddress: string;
  devices: string[];
  sessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  current: boolean;
  active: boolean;
}

/** Where this account has been signed in from: one row per address. */
export function useAddresses() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: queryKeys.addresses,
    queryFn: () => api.get<AddressRow[]>('/auth/addresses'),
    enabled: accessToken !== null,
    refetchInterval: 60_000,
  });
}

// ---- Chart arrangements ----------------------------------------------------

export interface ChartLayoutSummary {
  id: string;
  name: string;
  symbol: string;
  resolution: string;
  accountId: string | null;
  isDefault: boolean;
  updatedAt: string;
}

export interface ChartLayoutView extends ChartLayoutSummary {
  /** The renderer's own description. Never parsed here or on the server. */
  content: unknown;
}

/**
 * The layout to open, or `null` when this person has never saved one.
 *
 * `null` rather than an invented default: a chart the platform made up and
 * called the trader's own is a small lie noticed the first time it opens the
 * wrong instrument.
 */
export function useDefaultChartLayout(accountId: string | null) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['charts', 'default', accountId],
    queryFn: () =>
      api.get<ChartLayoutView | null>(
        accountId === null
          ? '/charts/layouts/default'
          : `/charts/layouts/default?accountId=${accountId}`,
      ),
    enabled: accessToken !== null,
    // A layout changes when this person changes it, and nobody else can.
    staleTime: Infinity,
  });
}

export function useSaveChartLayout() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      symbol: string;
      resolution: string;
      accountId: string | null;
      content: unknown;
      isDefault?: boolean;
    }) =>
      api.post<ChartLayoutSummary>('/charts/layouts', input, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: ['charts', 'default', variables.accountId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Price alerts
// ---------------------------------------------------------------------------

export interface PriceAlertView {
  id: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  source: 'BID' | 'ASK' | 'MID';
  price: string;
  status: 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED';
  note: string | null;
  expiresAt: string | null;
  triggeredAt: string | null;
  triggeredPrice: string | null;
  createdAt: string;
}

/**
 * A person's own alerts.
 *
 * Polled rather than pushed. An alert firing already reaches the client as a
 * notification; this list is the record of what is being watched, and a socket
 * event for it would be a second path to keep in step with the first for the
 * sake of a list nobody is staring at.
 */
export function usePriceAlerts() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.get<{ alerts: PriceAlertView[] }>('/alerts'),
    enabled: accessToken !== null,
    refetchInterval: 30_000,
  });
}

export function useCreatePriceAlert() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      symbol: string;
      condition: 'ABOVE' | 'BELOW';
      source?: 'BID' | 'ASK' | 'MID';
      /**
       * A string all the way down. A level a trader typed has to be compared as
       * they typed it; putting it through a JavaScript number on the way to a
       * NUMERIC column is how an alert set at 4600 fires at 4599.9999.
       */
      price: string;
      note?: string | null;
    }) => api.post<PriceAlertView>('/alerts', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}

export function useCancelPriceAlert() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<PriceAlertView>(`/alerts/${id}`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
}
