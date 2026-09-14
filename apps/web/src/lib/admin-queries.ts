'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from './session';

/**
 * The administrative API, as the browser sees it.
 *
 * Kept apart from `queries.ts` on purpose. That file is a trader's own account;
 * this one reaches across every account on the platform, and mixing them would
 * make it easy to reach for the wrong hook — a terminal component that
 * accidentally called `useAdminAccounts` would render somebody else's book.
 *
 * None of these hooks is a permission check. The server decides, on every
 * request, from the caller's own role; what the browser does with a 403 is
 * show it. A UI that hides a button is a courtesy, never a control.
 */

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  createdAt: string;
  accounts: number;
}

export interface AdminAccountRow {
  id: string;
  number: string;
  type: string;
  status: string;
  currency: string;
  balance: string;
  leverage: number;
  createdAt: string;
  positions: number;
  userId: string;
  email: string;
}

export interface AdminSessionRow {
  id: string;
  device: string;
  ipAddress: string | null;
  signedInAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface AdminUserDetail extends Omit<AdminUserRow, 'accounts'> {
  accountCount: number;
  accounts: Array<Omit<AdminAccountRow, 'userId' | 'email'>>;
  sessions: AdminSessionRow[];
}

export interface AtRiskRow {
  accountId: string;
  number: string;
  currency: string;
  userId: string;
  email: string;
  equity: string;
  balance: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string;
  floatingPnl: string;
  openPositions: number;
  marginCallLevelPercent: string | null;
  stopOutLevelPercent: string | null;
}

export interface ExposureRow {
  symbol: string;
  longVolume: string;
  shortVolume: string;
  netVolume: string;
  positions: number;
}

export interface RiskEventRow {
  id: string;
  accountId: string;
  accountNumber: string;
  rule: string;
  code: string;
  severity: string;
  message: string;
  snapshot: unknown;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface OperationsSummary {
  trading: { halted: boolean; reason?: string | null; since?: string | null };
  accounts: { total: number; active: number; withOpenPositions: number };
  positions: { open: number };
  orders: { resting: number; lastHour: number; rejectedLastHour: number };
  risk: { eventsLastDay: number; criticalLastDay: number };
  integrity: { open: number; bySeverity: Record<string, number> };
  /** By currency, never summed across them — there is no rate here to do it with. */
  money: {
    byCurrency: {
      currency: string;
      balance: string;
      depositedLastDay: string;
      withdrawnLastDay: string;
      commissionLastDay: string;
      swapLastDay: string;
      netPnlLastDay: string;
      closedTradesLastDay: number;
      volumeLastDay: string;
    }[];
  };
  reconciliation: { openFindings: number; lastRunAt: string | null };
  takenAt: string;
}

export interface IntegritySignalRow {
  id: string;
  accountId: string;
  code: string;
  severity: string;
  status: string;
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

const adminKeys = {
  users: (search: string) => ['admin', 'users', search] as const,
  brokers: ['admin', 'brokers'] as const,
  brokerConnections: ['admin', 'broker-connections'] as const,
  brokerConnectors: ['admin', 'broker-connectors'] as const,
  brokerMappings: (id: string) => ['admin', 'broker-mappings', id] as const,
  brokerCatalogue: (id: string) => ['admin', 'broker-catalogue', id] as const,
  brokerInbox: (id: string) => ['admin', 'broker-inbox', id] as const,
  unconfirmedOrders: ['admin', 'unconfirmed-orders'] as const,
  masterAccounts: ['admin', 'master-accounts'] as const,
  masterLinks: (id: string) => ['admin', 'master-links', id] as const,
  desk: (id: string) => ['admin', 'desk', id] as const,
  riskLimits: ['admin', 'risk-limits'] as const,
  blotter: (kind: string, query: string) => ['admin', 'blotter', kind, query] as const,
  orderHistory: (id: string) => ['admin', 'order-history', id] as const,
  sessions: (code: string) => ['admin', 'sessions', code] as const,
  securityFeed: (filter: string) => ['admin', 'security-feed', filter] as const,
  ipRules: ['admin', 'ip-rules'] as const,
  webhooks: ['admin', 'webhooks'] as const,
  features: ['admin', 'features'] as const,
  brokerFeatures: (id: string) => ['admin', 'broker-features', id] as const,
  webhookEvents: ['admin', 'webhook-events'] as const,
  webhookDeliveries: (id: string) => ['admin', 'webhook-deliveries', id] as const,
  user: (id: string) => ['admin', 'user', id] as const,
  accounts: (search: string) => ['admin', 'accounts', search] as const,
  account: (id: string) => ['admin', 'account', id] as const,
  atRisk: (below: number | null) => ['admin', 'at-risk', below ?? 'all'] as const,
  exposure: ['admin', 'exposure'] as const,
  riskEvents: (severity: string) => ['admin', 'risk-events', severity] as const,
  audit: (action: string) => ['admin', 'audit', action] as const,
  summary: ['admin', 'summary'] as const,
  signals: ['admin', 'signals'] as const,
  instruments: ['admin', 'instruments'] as const,
  roles: ['admin', 'roles'] as const,
  catalogue: ['admin', 'permission-catalogue'] as const,
  payments: (status: string) => ['admin', 'payments', status] as const,
  paymentEvents: (id: string) => ['admin', 'payment-events', id] as const,
  kycQueue: (status: string) => ['admin', 'kyc', status] as const,
  kycRecord: (id: string) => ['admin', 'kyc-record', id] as const,
  withdrawals: (status: string) => ['admin', 'withdrawals', status] as const,
  apiKeys: (search: string) => ['admin', 'api-keys', search] as const,
  serviceTokens: ['admin', 'service-tokens'] as const,
};

export interface AdminInstrumentRow {
  code: string;
  description: string;
  category: string;
  quoteCurrency: string;
  enabled: boolean;
  contractSize: string;
  tickSize: string;
  pricePrecision: number;
  minVolume: string;
  maxVolume: string;
  volumeStep: string;
  marginRate: string;
  commissionPerLot: string;
  swapLongPerLot: string;
  swapShortPerLot: string;
  openPositions: number;
  restingOrders: number;
}

export function useAdminUsers(search: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.users(search),
    queryFn: () =>
      api.get<AdminUserRow[]>('/admin/users', {
        query: search.trim() === '' ? {} : { search: search.trim() },
      }),
    enabled: accessToken !== null,
  });
}

export function useAdminUser(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.user(id ?? 'none'),
    queryFn: () => api.get<AdminUserDetail>(`/admin/users/${id ?? ''}`),
    enabled: id !== null,
  });
}

export function useAdminAccounts(search: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.accounts(search),
    queryFn: () =>
      api.get<AdminAccountRow[]>('/admin/accounts', {
        query: search.trim() === '' ? {} : { search: search.trim() },
      }),
    enabled: accessToken !== null,
  });
}

/**
 * One account, by id.
 *
 * The list is a search and this is a link. An operator is given an account
 * number in a message and needs to arrive at that account, not at a search box
 * they then retype it into — which is the whole reason the route exists.
 */
export function useAdminAccount(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.account(id ?? 'none'),
    queryFn: () => api.get<AdminAccountRow>(`/admin/accounts/${id ?? ''}`),
    enabled: id !== null,
  });
}

/**
 * `belowPercent` of `null` means every account with margin committed.
 *
 * Not "a very large number". A well-capitalised account sits at several hundred
 * thousand percent, so a filter that spelled "anything" as 100,000 would hide
 * exactly the accounts it claimed to be showing.
 */
export function useAtRisk(belowPercent: number | null) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.atRisk(belowPercent),
    queryFn: () =>
      api.get<AtRiskRow[]>('/admin/risk/at-risk', {
        query: belowPercent === null ? {} : { below: belowPercent },
      }),
    enabled: accessToken !== null,
    // Valued live on the server, and a risk manager watching an account is
    // watching it now. This is the one screen where a refresh interval is the
    // right mechanism — nothing pushes a margin level for an account this
    // browser does not own.
    refetchInterval: 15_000,
  });
}

export function useExposure() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.exposure,
    queryFn: () => api.get<ExposureRow[]>('/admin/risk/exposure'),
    enabled: accessToken !== null,
    refetchInterval: 30_000,
  });
}

export function useRiskEvents(severity: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.riskEvents(severity),
    queryFn: () =>
      api.get<RiskEventRow[]>('/admin/risk/events', {
        query: severity === '' ? { limit: 200 } : { severity, limit: 200 },
      }),
    enabled: accessToken !== null,
  });
}

export function useAuditTrail(action: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.audit(action),
    queryFn: () =>
      api.get<AuditRow[]>('/admin/audit', {
        query: action === '' ? { limit: 200 } : { action, limit: 200 },
      }),
    enabled: accessToken !== null,
  });
}

export function useOperationsSummary() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.summary,
    queryFn: () => api.get<OperationsSummary>('/operations/summary'),
    enabled: accessToken !== null,
    refetchInterval: 20_000,
  });
}

export function useIntegritySignals() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.signals,
    queryFn: () => api.get<IntegritySignalRow[]>('/integrity/signals'),
    enabled: accessToken !== null,
  });
}

/** Invalidates everything an administrative action could have changed. */
function useAdminInvalidate() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: ['admin'] });
}

export function useSuspendUser() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { userId: string; suspend: boolean; reason: string }) =>
      api.post(
        `/admin/users/${input.userId}/${input.suspend ? 'suspend' : 'reinstate'}`,
        { reason: input.reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

/** A device as staff see it. Mirrors `AdminDeviceDto`; no token, ever. */
export interface AdminDeviceRow {
  id: string;
  platform: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  hasPushToken: boolean;
  pushTokenFingerprint: string | null;
  pushTokenRejectedAt: string | null;
  isActive: boolean;
  revokedByStaffAt: string | null;
  lastSeenAt: string;
  createdAt: string;
}

/**
 * The phones, tablets and browsers on somebody's account (§13-14).
 *
 * Its own query rather than a field on the person, because it is read only
 * when an operator opens somebody's record for a lost-phone investigation, and
 * folding it into the person's detail would fetch it for every search result.
 */
export function useAdminUserDevices(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: [...adminKeys.user(id ?? 'none'), 'devices'],
    queryFn: () => api.get<AdminDeviceRow[]>(`/admin/users/${id ?? ''}/devices`),
    enabled: id !== null,
  });
}

export function useRevokeDevice() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { userId: string; deviceId: string; reason: string; restore?: boolean }) =>
      api.post(
        `/admin/users/${input.userId}/devices/${input.deviceId}/${
          input.restore === true ? 'restore' : 'revoke'
        }`,
        { reason: input.reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export function useForceSignOut() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { userId: string; reason: string }) =>
      api.post(
        `/admin/users/${input.userId}/sign-out`,
        { reason: input.reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export function useUnlockUser() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { userId: string }) =>
      api.post(`/admin/users/${input.userId}/unlock`, {}, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: invalidate,
  });
}

export function useSetAccountStatus() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { accountId: string; status: string; reason: string }) =>
      api.post(
        `/admin/accounts/${input.accountId}/status`,
        { status: input.status, reason: input.reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export interface AdjustmentInput {
  accountId: string;
  amount: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'FEE';
  reason: string;
  totpCode: string;
}

/**
 * Posting a correcting entry to a ledger.
 *
 * The idempotency key is minted once per attempt here, exactly as the order
 * ticket does it, and for the same reason: a network failure the client retries
 * must not be able to credit an account twice. On this endpoint the key becomes
 * the ledger row's own unique constraint, so the guarantee is the database's
 * rather than a promise.
 */
export function useAdjustBalance() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: AdjustmentInput) => {
      const { accountId, ...body } = input;
      return api.post<{ entryId: string; balanceAfter: string; amount: string }>(
        `/admin/accounts/${accountId}/adjustments`,
        body,
        { idempotencyKey: crypto.randomUUID() },
      );
    },
    onSuccess: invalidate,
  });
}

export function useHaltTrading() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { halt: boolean; reason: string }) =>
      api.post(
        `/operations/${input.halt ? 'halt' : 'resume'}`,
        input.halt ? { reason: input.reason } : {},
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

// ─── Reconciliation ────────────────────────────────────────────────────────

export interface ReconciliationRunRow {
  id: string;
  status: string;
  trigger: string;
  accountsChecked: number;
  findingsRaised: number;
  findingsRecurred: number;
  criticalCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ReconciliationFindingRow {
  id: string;
  accountId: string;
  accountNumber: string;
  code: string;
  severity: string;
  status: string;
  expected: string;
  actual: string;
  difference: string;
  subjectType: string | null;
  subjectId: string | null;
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export function useReconciliationRuns() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'reconciliation-runs'],
    queryFn: () => api.get<ReconciliationRunRow[]>('/reconciliation/runs'),
    enabled: accessToken !== null,
    // A run in flight finishes without telling anybody, so the list is refreshed
    // rather than left showing RUNNING until somebody clicks away and back.
    refetchInterval: 20_000,
  });
}

export function useReconciliationFindings(status: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'reconciliation-findings', status],
    queryFn: () =>
      api.get<ReconciliationFindingRow[]>('/reconciliation/findings', {
        query: status === '' ? { limit: 200 } : { status, limit: 200 },
      }),
    enabled: accessToken !== null,
  });
}

export function useSetFindingStatus() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: string; note: string | null }) =>
      api.post(
        `/reconciliation/findings/${input.id}/status`,
        { status: input.status, ...(input.note === null ? {} : { note: input.note }) },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export function useRequestReconciliation() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ runId: string; alreadyRunning: boolean }>(
        '/reconciliation/runs',
        {},
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin'] }),
  });
}

/** What the platform trades, and on what terms. */
export function useAdminInstruments() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.instruments,
    queryFn: () => api.get<AdminInstrumentRow[]>('/admin/instruments'),
    enabled: accessToken !== null,
  });
}

/**
 * Suspend or resume one instrument.
 *
 * The reply carries how many positions are open in it, because suspending
 * closes none of them and whoever pressed the button should see what they have
 * left standing.
 */
export function useSetInstrumentEnabled() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: { code: string; enabled: boolean; reason: string }) =>
      api.post<{ code: string; enabled: boolean; openPositions: number }>(
        `/admin/instruments/${input.code}/enabled`,
        { enabled: input.enabled, reason: input.reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

/** Margin, commission, swap and the largest order accepted. */
export function useSetInstrumentTerms() {
  const { api } = useSession();
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: (input: {
      code: string;
      reason: string;
      marginRate?: string;
      commissionPerLot?: string;
      swapLongPerLot?: string;
      swapShortPerLot?: string;
      maxVolume?: string;
    }) => {
      const { code, ...body } = input;
      return api.post<{ code: string; changed: string[]; openPositions: number }>(
        `/admin/instruments/${code}/terms`,
        body,
        { idempotencyKey: crypto.randomUUID() },
      );
    },
    onSuccess: invalidate,
  });
}

export interface RoleRow {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export function usePermissionCatalogue() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.catalogue,
    queryFn: () => api.get<{ permissions: string[] }>('/permissions/catalogue'),
    enabled: accessToken !== null,
    // The catalogue is compiled into the build: it cannot change without a
    // deploy, and a deploy reloads the page.
    staleTime: Infinity,
  });
}

export function useRoles() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: adminKeys.roles,
    queryFn: () => api.get<{ roles: RoleRow[] }>('/permissions/roles'),
    enabled: accessToken !== null,
  });
}

/**
 * Replaces what a role carries.
 *
 * A whole set rather than add/remove, matching the endpoint, and for the same
 * reason: two administrators editing one role at once must not silently merge
 * into a union nobody chose.
 *
 * The refusals — an editor cannot grant what they do not hold, and no role may
 * hold `accounts.adjust` beside a capability that opens a position — are the
 * server's, surfaced here as the error they arrive as. Re-implementing them in
 * the browser would be a second copy of a rule that exists to be hard to bend.
 */
/**
 * Restores a built-in role to what this build ships.
 *
 * A separate call from `useSetRolePermissions` because it is a separate act on
 * the server: the editor chooses a set and is bounded by what the editor holds,
 * this names a role and restores a constant. That distinction is what lets it
 * put back `USER`'s `orders.create`, which no administrator can grant by hand.
 */
export function useResetRolePermissions() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key }: { key: string }) =>
      api.post<RoleRow>(
        `/permissions/roles/${key}/reset`,
        {},
        {
          idempotencyKey: crypto.randomUUID(),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.roles });
      void client.invalidateQueries({ queryKey: ['permissions', 'me'] });
    },
  });
}

export function useSetRolePermissions() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, permissions }: { key: string; permissions: string[] }) =>
      api.put<RoleRow>(`/permissions/roles/${key}`, { permissions }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.roles });
      // The signed-in operator's own capabilities may have just changed.
      void client.invalidateQueries({ queryKey: ['permissions', 'me'] });
    },
  });
}

export interface AdminPaymentRow {
  id: string;
  userId: string;
  email: string;
  provider: string;
  amount: string;
  currency: string;
  status: string;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface AdminPaymentEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  providerStatus: string;
  status: string;
  outcome: string;
  note: string | null;
  createdAt: string;
}

export function useAdminPayments(status: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.payments(status),
    queryFn: () =>
      api.get<{ payments: AdminPaymentRow[] }>(
        status === 'all' ? '/admin/payments' : `/admin/payments?status=${status}`,
      ),
  });
}

/**
 * Everything a provider has said about one payment.
 *
 * Including what the platform refused to act on. An operator looking at a
 * deposit a payer says they made needs to see the delivery that was ignored, or
 * the one whose amount did not match — a screen that showed only what was
 * applied would show nothing at all in exactly the cases someone is asking
 * about.
 */
export function useAdminPaymentEvents(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.paymentEvents(id ?? 'none'),
    queryFn: () =>
      api.get<{ events: AdminPaymentEventRow[] }>(`/admin/payments/${id ?? ''}/events`),
    enabled: id !== null,
  });
}

/**
 * Settling a payment by hand.
 *
 * No amount: it is the amount on the intent, which is what the payer was told to
 * send. An operator who could type a different number could credit any amount
 * against any payment, which is `wallet.adjust` wearing a narrower name.
 */
export function useSettlePayment() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      outcome,
      reason,
    }: {
      id: string;
      outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
      reason: string;
    }) =>
      api.post<AdminPaymentRow>(
        `/admin/payments/${id}/settle`,
        { outcome, reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: ['admin', 'payments'] });
      void client.invalidateQueries({ queryKey: adminKeys.paymentEvents(input.id) });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export interface AdminKycRow {
  id: string;
  userId: string;
  email: string;
  status: string;
  submittedAt: string | null;
  reviewerId: string | null;
  decidedAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  documentKinds: string[];
}

export interface AdminKycDocument {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  filename: string | null;
  uploadedAt: string;
  purged: boolean;
  current: boolean;
}

export interface AdminKycDetail extends AdminKycRow {
  provider: string;
  documents: AdminKycDocument[];
}

export function useKycQueue(status: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.kycQueue(status),
    queryFn: () =>
      api.get<{ records: AdminKycRow[] }>(
        status === 'queue' ? '/admin/kyc' : `/admin/kyc?status=${status}`,
      ),
  });
}

export function useKycRecord(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.kycRecord(id ?? 'none'),
    queryFn: () => api.get<AdminKycDetail>(`/admin/kyc/${id ?? ''}`),
    enabled: id !== null,
  });
}

/**
 * Opens one document.
 *
 * Not a query: it is not cached, not refetched, and not kept. Every call is an
 * audited act on the server, and a cache that replayed the bytes without a
 * second audit row would make the trail lie about how often they were seen.
 * The page holds the object URL only while the document is on screen.
 */
export function useOpenKycDocument() {
  const { api } = useSession();
  return useMutation({
    mutationFn: ({ recordId, documentId }: { recordId: string; documentId: string }) =>
      api.getBytes(`/admin/kyc/${recordId}/documents/${documentId}`),
  });
}

function useKycAction<TInput extends { id: string }>(
  run: (api: ReturnType<typeof useSession>['api'], input: TInput) => Promise<AdminKycDetail>,
) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(api, input),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: ['admin', 'kyc'] });
      void client.invalidateQueries({ queryKey: adminKeys.kycRecord(input.id) });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useClaimKyc() {
  return useKycAction<{ id: string }>((api, { id }) =>
    api.post<AdminKycDetail>(`/admin/kyc/${id}/claim`, {}, { idempotencyKey: crypto.randomUUID() }),
  );
}

export function useReleaseKyc() {
  return useKycAction<{ id: string }>((api, { id }) =>
    api.post<AdminKycDetail>(
      `/admin/kyc/${id}/release`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
}

export function useDecideKyc() {
  return useKycAction<{ id: string; outcome: 'VERIFIED' | 'REJECTED'; reason: string }>(
    (api, { id, outcome, reason }) =>
      api.post<AdminKycDetail>(
        `/admin/kyc/${id}/decide`,
        { outcome, reason },
        { idempotencyKey: crypto.randomUUID() },
      ),
  );
}

export function useRevokeKyc() {
  return useKycAction<{ id: string; reason: string }>((api, { id, reason }) =>
    api.post<AdminKycDetail>(
      `/admin/kyc/${id}/revoke`,
      { reason },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
}

export interface AdminWithdrawalRow {
  id: string;
  userId: string;
  email: string;
  walletId: string;
  amount: string;
  currency: string;
  status: string;
  destinationHint: string;
  reason: string | null;
  provider: string;
  providerReference: string | null;
  autoApproved: boolean;
  reviewerId: string | null;
  approvedById: string | null;
  paidById: string | null;
  createdAt: string;
  approvedAt: string | null;
  decidedAt: string | null;
  identityVerified: boolean;
}

export function useAdminWithdrawals(status: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.withdrawals(status),
    queryFn: () =>
      api.get<{ withdrawals: AdminWithdrawalRow[] }>(
        status === 'queue' ? '/admin/withdrawals' : `/admin/withdrawals?status=${status}`,
      ),
  });
}

/**
 * Opens the destination. A mutation rather than a query: not cached, not
 * refetched, and every call is an audited act on the server.
 */
export function useOpenWithdrawalDestination() {
  const { api } = useSession();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.get<{ destination: string }>(`/admin/withdrawals/${id}/destination`),
  });
}

function useWithdrawalAction<TInput extends { id: string }>(
  run: (api: ReturnType<typeof useSession>['api'], input: TInput) => Promise<AdminWithdrawalRow>,
) {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(api, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

const key = () => ({ idempotencyKey: crypto.randomUUID() });

export function useClaimWithdrawal() {
  return useWithdrawalAction<{ id: string }>((api, { id }) =>
    api.post<AdminWithdrawalRow>(`/admin/withdrawals/${id}/claim`, {}, key()),
  );
}

export function useReleaseWithdrawal() {
  return useWithdrawalAction<{ id: string }>((api, { id }) =>
    api.post<AdminWithdrawalRow>(`/admin/withdrawals/${id}/release`, {}, key()),
  );
}

export function useDecideWithdrawal() {
  return useWithdrawalAction<{ id: string; outcome: 'APPROVED' | 'REJECTED'; reason: string }>(
    (api, { id, outcome, reason }) =>
      api.post<AdminWithdrawalRow>(`/admin/withdrawals/${id}/decide`, { outcome, reason }, key()),
  );
}

export function useStartPayout() {
  return useWithdrawalAction<{ id: string; providerReference: string }>(
    (api, { id, providerReference }) =>
      api.post<AdminWithdrawalRow>(`/admin/withdrawals/${id}/payout`, { providerReference }, key()),
  );
}

export function useSettlePayout() {
  return useWithdrawalAction<{ id: string; outcome: 'PAID' | 'FAILED'; reason: string }>(
    (api, { id, outcome, reason }) =>
      api.post<AdminWithdrawalRow>(`/admin/withdrawals/${id}/settle`, { outcome, reason }, key()),
  );
}

/** Puts a person into a role. Their sessions end; the people views refetch. */
export function useAssignRole() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role, reason }: { id: string; role: string; reason: string }) =>
      api.post<{ userId: string; role: string; sessionsEnded: number }>(
        `/admin/users/${id}/role`,
        { role, reason },
        key(),
      ),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: adminKeys.user(input.id) });
      void client.invalidateQueries({ queryKey: ['admin', 'users'] });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

// ---------------------------------------------------------------------------
// Credentials: everyone's API keys, and the firm's service tokens
// ---------------------------------------------------------------------------

export interface AdminApiKeyRow {
  id: string;
  userId: string;
  email: string;
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

export interface ServiceTokenRow {
  id: string;
  name: string;
  description: string | null;
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
  createdBy: string;
  usage7d: { requests: number; refused: number; throttled: number };
}

export function useAdminApiKeys(search: string) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.apiKeys(search),
    queryFn: () =>
      api.get<{ keys: AdminApiKeyRow[] }>('/admin/api-keys', {
        query: search === '' ? {} : { search },
      }),
  });
}

export function useRevokeAnyApiKey() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<AdminApiKeyRow>(`/admin/api-keys/${id}/revoke`, { reason }, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'api-keys'] });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useServiceTokens() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.serviceTokens,
    queryFn: () => api.get<{ tokens: ServiceTokenRow[] }>('/admin/service-tokens'),
  });
}

/** The secret is in the response and nowhere else; the panel shows it once. */
export function useMintServiceToken() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description?: string;
      permissions: string[];
      expiresInDays?: number;
      rateLimitPerMinute?: number;
    }) =>
      api.post<{ token: ServiceTokenRow; secret: string }>('/admin/service-tokens', input, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.serviceTokens });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useRevokeServiceToken() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<ServiceTokenRow>(`/admin/service-tokens/${id}/revoke`, { reason }, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.serviceTokens });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

// ---- Brokers (platform only) ---------------------------------------------

export interface BrokerRow {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  primaryHost: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  defaultExecutionMode: 'INTERNAL' | 'EXTERNAL_BROKER';
  users: number;
  accounts: number;
  createdAt: string;
}

export interface BrokerCreated {
  broker: BrokerRow;
  /** Shown once; the server keeps a hash and a fingerprint, nothing more. */
  ownerInvite: { id: string; code: string; fingerprint: string; expiresAt: string };
}

export function useBrokers() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokers,
    queryFn: () => api.get<{ brokers: BrokerRow[] }>('/admin/brokers'),
  });
}

export function useCreateBroker() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      slug: string;
      name: string;
      legalName?: string;
      primaryHost?: string;
      defaultExecutionMode?: 'INTERNAL' | 'EXTERNAL_BROKER';
    }) => api.post<BrokerCreated>('/admin/brokers', input, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokers });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useSetBrokerStatus() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      status,
      reason,
    }: {
      id: string;
      status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
      reason: string;
    }) => api.post<BrokerRow>(`/admin/brokers/${id}/status`, { status, reason }, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokers });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

// ---- Security feed (the firm's) ------------------------------------------

export interface AdminSecurityEventRow {
  id: string;
  kind: string;
  severity: 'INFO' | 'NOTICE' | 'WARNING';
  at: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  byOther: boolean;
  details: Record<string, unknown> | null;
  userId: string | null;
  userEmail: string | null;
  userDisplayName: string | null;
  actorId: string | null;
  actorType: string;
  auditLogId: string | null;
}

export function useSecurityFeed(filter: { severity?: string; kind?: string; userId?: string }) {
  const { api } = useSession();
  const query: Record<string, string> = {};
  if (filter.severity) query['severity'] = filter.severity;
  if (filter.kind) query['kind'] = filter.kind;
  if (filter.userId) query['userId'] = filter.userId;
  return useQuery({
    queryKey: adminKeys.securityFeed(JSON.stringify(query)),
    queryFn: () =>
      api.get<{ events: AdminSecurityEventRow[] }>('/admin/security/events', { query }),
    refetchInterval: 30_000,
  });
}

// ---- Where the firm may be reached from (§46) ------------------------------

export interface IpRuleRow {
  id: string;
  cidr: string;
  kind: 'ALLOW' | 'DENY';
  scope: 'STAFF' | 'EVERYONE';
  note: string;
  enabled: boolean;
  createdAt: string;
  createdBy: { id: string; email: string; displayName: string | null } | null;
}

export interface IpRulesView {
  /**
   * Whether a rule written here would actually be enforced. False while the
   * deployment has not said what sits in front of it, or while this request's
   * own address could not be established — in which case the screen says so
   * rather than showing a list that looks like a control.
   */
  enforceable: boolean;
  yourAddress: string;
  yourAddressTrusted: boolean;
  rules: IpRuleRow[];
}

export function useIpRules() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.ipRules,
    queryFn: () => api.get<IpRulesView>('/security/ip-rules'),
  });
}

function useIpRulesInvalidate() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: adminKeys.ipRules });
}

export function useCreateIpRule() {
  const { api } = useSession();
  const invalidate = useIpRulesInvalidate();
  return useMutation({
    mutationFn: (input: {
      cidr: string;
      kind: 'ALLOW' | 'DENY';
      scope: 'STAFF' | 'EVERYONE';
      note: string;
    }) => api.post('/security/ip-rules', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: invalidate,
  });
}

export function useSetIpRuleEnabled() {
  const { api } = useSession();
  const invalidate = useIpRulesInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.post(
        `/security/ip-rules/${input.id}/enabled`,
        { enabled: input.enabled },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteIpRule() {
  const { api } = useSession();
  const invalidate = useIpRulesInvalidate();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      api.delete(`/security/ip-rules/${input.id}`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: invalidate,
  });
}

// ---- Feature flags (§95) ---------------------------------------------------

export interface FeatureRow {
  key: string;
  name: string;
  description: string;
  authority: 'PLATFORM' | 'FIRM';
  enforcement: 'SERVER' | 'CLIENT';
  default: boolean;
  enabled: boolean;
  override: { note: string; updatedAt: string } | null;
}

export function useAdminFeatures() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.features,
    queryFn: () => api.get<FeatureRow[]>('/admin/features'),
  });
}

export function useBrokerFeatures(brokerId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerFeatures(brokerId ?? ''),
    queryFn: () => api.get<FeatureRow[]>(`/admin/brokers/${brokerId}/features`),
    enabled: brokerId !== null,
  });
}

export function useSetFeature() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; enabled: boolean; note: string; brokerId?: string }) =>
      api.post(
        input.brokerId === undefined
          ? `/admin/features/${input.key}`
          : `/admin/brokers/${input.brokerId}/features/${input.key}`,
        { enabled: input.enabled, note: input.note },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.features });
      void client.invalidateQueries({ queryKey: ['admin', 'broker-features'] });
      void client.invalidateQueries({ queryKey: ['features'] });
    },
  });
}

// ---- Webhooks (§49) --------------------------------------------------------

export interface WebhookEndpointRow {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  consecutiveFailures: number;
  secretHint: string;
  previousSecretExpiresAt: string | null;
  createdAt: string;
  createdBy: { id: string; email: string; displayName: string | null } | null;
}

export interface WebhookDeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'EXHAUSTED';
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  durationMs: number | null;
  replayOfId: string | null;
  createdAt: string;
}

export function useWebhooks() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.webhooks,
    queryFn: () => api.get<WebhookEndpointRow[]>('/admin/webhooks'),
    refetchInterval: 30_000,
  });
}

export function useWebhookEventTypes() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.webhookEvents,
    queryFn: () => api.get<{ events: string[] }>('/admin/webhooks/events'),
    staleTime: 60 * 60_000,
  });
}

export function useWebhookDeliveries(endpointId: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.webhookDeliveries(endpointId ?? ''),
    queryFn: () =>
      api.get<WebhookDeliveryRow[]>(`/admin/webhooks/${endpointId}/deliveries?limit=100`),
    enabled: endpointId !== null,
    refetchInterval: 15_000,
  });
}

function useWebhooksInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: adminKeys.webhooks });
    void client.invalidateQueries({ queryKey: ['admin', 'webhook-deliveries'] });
  };
}

export function useCreateWebhook() {
  const { api } = useSession();
  const invalidate = useWebhooksInvalidate();
  return useMutation({
    mutationFn: (input: { url: string; description: string; events: string[] }) =>
      api.post<{ endpoint: { id: string; url: string }; secret: string }>(
        '/admin/webhooks',
        input,
        {
          idempotencyKey: crypto.randomUUID(),
        },
      ),
    onSuccess: invalidate,
  });
}

export function useSetWebhookEnabled() {
  const { api } = useSession();
  const invalidate = useWebhooksInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.post(
        `/admin/webhooks/${input.id}/enabled`,
        { enabled: input.enabled },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export function useRotateWebhookSecret() {
  const { api } = useSession();
  const invalidate = useWebhooksInvalidate();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      api.post<{ id: string; secret: string; previousSecretValidUntil: string }>(
        `/admin/webhooks/${input.id}/rotate-secret`,
        {},
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteWebhook() {
  const { api } = useSession();
  const invalidate = useWebhooksInvalidate();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      api.delete(`/admin/webhooks/${input.id}`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: invalidate,
  });
}

export function useReplayWebhookDelivery() {
  const { api } = useSession();
  const invalidate = useWebhooksInvalidate();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      api.post(
        `/admin/webhooks/deliveries/${input.id}/replay`,
        {},
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: invalidate,
  });
}

// ---- Broker connections ---------------------------------------------------

export interface ConnectorRow {
  kind: string;
  displayName: string;
  /** What the connector was written against. Empty means the mock. */
  documentation: string;
  credentialFields: { key: string; label: string; secret: boolean }[];
}

export interface BrokerCredentialRow {
  id: string;
  kind: string;
  /** Identifies the credential. There is no field here that could use it. */
  fingerprint: string;
  visible: Record<string, string> | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface BrokerConnectionRow {
  id: string;
  name: string;
  adapterKind: string;
  enabled: boolean;
  status:
    | 'UNKNOWN'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'DEGRADED'
    | 'DISCONNECTED'
    | 'AUTH_FAILED'
    | 'RATE_LIMITED';
  capabilities: Record<string, unknown> | null;
  lastHeartbeatAt: string | null;
  lastQuoteAt: string | null;
  lastOrderEventAt: string | null;
  latencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  statusChangedAt: string | null;
  createdAt: string;
  credentials: BrokerCredentialRow[];
}

export function useBrokerConnectors() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerConnectors,
    queryFn: () => api.get<{ connectors: ConnectorRow[] }>('/admin/broker-connections/connectors'),
    staleTime: 5 * 60_000,
  });
}

export function useBrokerConnections() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerConnections,
    queryFn: () => api.get<{ connections: BrokerConnectionRow[] }>('/admin/broker-connections'),
    // A venue's state is the one thing on this screen that changes by itself.
    refetchInterval: 15_000,
  });
}

export function useCreateBrokerConnection() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; adapterKind: string }) =>
      api.post<BrokerConnectionRow>('/admin/broker-connections', input, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerConnections });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

/**
 * Sets the credentials. The values leave this browser once, over TLS, and are
 * sealed on arrival; nothing ever sends them back, so the form clears itself
 * and the panel afterwards shows a fingerprint.
 */
export function useSetBrokerCredentials() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      kind,
      fields,
    }: {
      id: string;
      kind: string;
      fields: Record<string, string>;
    }) =>
      api.post<BrokerConnectionRow>(
        `/admin/broker-connections/${id}/credentials`,
        { kind, fields },
        key(),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerConnections });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useSetBrokerConnectionEnabled() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled, reason }: { id: string; enabled: boolean; reason: string }) =>
      api.post<BrokerConnectionRow>(
        `/admin/broker-connections/${id}/enabled`,
        { enabled, reason },
        key(),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerConnections });
    },
  });
}

export function useTestBrokerConnection() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{
        status: string;
        capabilities: Record<string, unknown> | null;
        failure: { code: string; message: string } | null;
      }>(`/admin/broker-connections/${id}/test`, {}, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerConnections });
    },
  });
}

// ---- Instrument mappings, the inbox, and unconfirmed orders ---------------

export interface MappingRow {
  id: string;
  symbolId: string;
  symbolCode: string;
  externalSymbol: string;
  contractSize: string | null;
  volumeStep: string | null;
  minVolume: string | null;
  maxVolume: string | null;
  priceDecimals: number | null;
  enabled: boolean;
  syncedAt: string | null;
}

export interface CatalogueRow {
  externalSymbol: string;
  description: string;
  quoteCurrency: string;
  contractSize: string;
  volumeStep: string;
  minVolume: string;
  maxVolume: string;
  priceDecimals: number;
  tradable: boolean;
  /** The platform symbol this is already mapped to, if any. */
  mappedTo: string | null;
}

export interface InboundEventRow {
  id: string;
  externalEventId: string;
  sequence: string | null;
  kind: string;
  externalAccountId: string | null;
  status: 'PENDING' | 'APPLIED' | 'SKIPPED' | 'FAILED';
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  occurredAt: string;
  receivedAt: string;
  appliedAt: string | null;
}

export interface SyncReportRow {
  checked: number;
  changed: { symbolCode: string; differences: string[] }[];
  /** Mapped instruments the venue no longer lists. Reported, never repaired. */
  missing: string[];
}

export function useBrokerMappings(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerMappings(id ?? ''),
    queryFn: () => api.get<{ mappings: MappingRow[] }>(`/admin/broker-connections/${id}/mappings`),
    enabled: id !== null,
  });
}

/**
 * The venue's catalogue, read live on the server each time. It is what a
 * person maps against, and a cached one is how an instrument gets mapped to a
 * symbol the venue retired last month.
 */
export function useBrokerCatalogue(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerCatalogue(id ?? ''),
    queryFn: () =>
      api.get<{ instruments: CatalogueRow[] }>(`/admin/broker-connections/${id}/catalogue`),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export function useMapInstrument() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      symbolCode,
      externalSymbol,
    }: {
      id: string;
      symbolCode: string;
      externalSymbol: string;
    }) =>
      api.post<MappingRow>(
        `/admin/broker-connections/${id}/mappings`,
        { symbolCode, externalSymbol },
        key(),
      ),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerMappings(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.brokerCatalogue(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

export function useSetMappingEnabled() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      symbolCode,
      enabled,
    }: {
      id: string;
      symbolCode: string;
      enabled: boolean;
    }) =>
      api.post<MappingRow>(
        `/admin/broker-connections/${id}/mappings/enabled`,
        { symbolCode, enabled },
        key(),
      ),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerMappings(variables.id) });
    },
  });
}

export function useSyncMappings() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<SyncReportRow>(`/admin/broker-connections/${id}/mappings/sync`, {}, key()),
    onSuccess: (_report, id) => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerMappings(id) });
      void client.invalidateQueries({ queryKey: adminKeys.brokerCatalogue(id) });
    },
  });
}

export function useBrokerInbox(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.brokerInbox(id ?? ''),
    queryFn: () => api.get<{ events: InboundEventRow[] }>(`/admin/broker-connections/${id}/inbox`),
    enabled: id !== null,
    refetchInterval: 15_000,
  });
}

export function useReplayInboundEvent() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, eventId }: { id: string; eventId: string }) =>
      api.post<{ replayed: true }>(
        `/admin/broker-connections/${id}/inbox/${eventId}/replay`,
        {},
        key(),
      ),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.brokerInbox(variables.id) });
    },
  });
}

export interface UnconfirmedOrderRow {
  id: string;
  clientOrderId: string | null;
  accountId: string;
  createdAt: string;
}

export function useUnconfirmedOrders() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.unconfirmedOrders,
    queryFn: () => api.get<{ orders: UnconfirmedOrderRow[] }>('/admin/venue-recovery/unconfirmed'),
    refetchInterval: 15_000,
  });
}

/** Asks the venue again, now. It asks; it never resends and never guesses. */
export function useResolveUnconfirmed() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      api.post<{ resolved: boolean; status: string | null; reason: string | null }>(
        `/admin/venue-recovery/unconfirmed/${orderId}/resolve`,
        {},
        key(),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.unconfirmedOrders });
    },
  });
}

// ---- Master accounts, desks, and the risk hierarchy ------------------------

export interface MasterAccountRow {
  id: string;
  name: string;
  status: string;
  operatorUserId: string;
  activeLinks: number;
  createdAt: string;
}

export interface MasterLinkRow {
  id: string;
  accountId: string;
  accountNumber: string;
  capabilities: string[];
  /** The preset it was granted as, when it was granted as one. */
  grantedAsRole: string | null;
  /** What its capabilities amount to today. Null when they are their own thing. */
  role: string | null;
  status: string;
  grantedByUserId: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface DeskAccountRow {
  accountId: string;
  accountNumber: string;
  currency: string;
  capabilities: string[];
  balance: string;
  equity: string;
  usedMargin: string;
  freeMargin: string;
  floatingPnl: string;
  marginLevel: string | null;
  openPositions: number;
  rateToDesk: string | null;
  equityInDeskCurrency: string | null;
}

export interface DeskExposureRow {
  symbol: string;
  netVolume: string;
  grossNotional: string | null;
  accounts: number;
}

export interface DeskViewRow {
  masterAccountId: string;
  name: string;
  currency: string;
  accounts: DeskAccountRow[];
  exposure: DeskExposureRow[];
  totals: {
    accounts: number;
    balance: string | null;
    equity: string | null;
    usedMargin: string | null;
    floatingPnl: string | null;
    openPositions: number;
    grossNotional: string | null;
  };
  /** Accounts that could not be priced into the desk's currency. Named, never dropped. */
  unpriced: string[];
}

export interface RiskLimitSetRow {
  level: 'PLATFORM' | 'BROKER' | 'DESK';
  masterAccountId: string | null;
  maxPositionVolume: string | null;
  maxOpenPositions: number | null;
  maxGrossNotional: string | null;
  maxSymbolNetVolume: string | null;
  updatedByUserId: string | null;
  updatedAt: string | null;
}

export type RiskLimitInput = {
  maxPositionVolume?: string | null;
  maxOpenPositions?: number | null;
  maxGrossNotional?: string | null;
  maxSymbolNetVolume?: string | null;
};

export function useMasterAccounts() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.masterAccounts,
    queryFn: () => api.get<MasterAccountRow[]>('/master-accounts'),
  });
}

export function useMasterLinks(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.masterLinks(id ?? ''),
    queryFn: () => api.get<MasterLinkRow[]>(`/master-accounts/${id}/links`),
    enabled: id !== null,
  });
}

export function useDeskView(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.desk(id ?? ''),
    queryFn: () => api.get<DeskViewRow>(`/master-accounts/${id}/desk`),
    enabled: id !== null,
    // A book moves with the market.
    refetchInterval: 10_000,
  });
}

export function useCreateMasterAccount() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { operatorUserId: string; name: string }) =>
      api.post<MasterAccountRow>('/master-accounts', input, key()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.masterAccounts });
    },
  });
}

export function useGrantMasterLink() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, accountId, role }: { id: string; accountId: string; role: string }) =>
      api.post<MasterLinkRow>(`/master-accounts/${id}/links`, { accountId, role }, key()),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.masterLinks(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.desk(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.masterAccounts });
    },
  });
}

export function useRevokeMasterLink() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, accountId }: { id: string; accountId: string }) =>
      api.delete<MasterLinkRow>(`/master-accounts/${id}/links/${accountId}`, key()),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.masterLinks(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.desk(variables.id) });
      void client.invalidateQueries({ queryKey: adminKeys.masterAccounts });
    },
  });
}

export function useRiskLimits() {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.riskLimits,
    queryFn: () => api.get<RiskLimitSetRow[]>('/admin/risk/limits'),
  });
}

/** Refused by the server when it would be looser than the layer above. */
export function useSetRiskLimits() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      level,
      masterAccountId,
      limits,
    }: {
      level: 'PLATFORM' | 'BROKER' | 'DESK';
      masterAccountId?: string;
      limits: RiskLimitInput;
    }) =>
      api.post<RiskLimitSetRow>(
        level === 'DESK'
          ? `/admin/risk/limits/desk/${masterAccountId}`
          : `/admin/risk/limits/${level.toLowerCase()}`,
        limits,
        key(),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminKeys.riskLimits });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

// ---- The firm's book, and the trading week ---------------------------------

export interface BlotterFilters {
  accountNumber?: string;
  symbol?: string;
  side?: 'BUY' | 'SELL';
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface BlotterPage<T> {
  rows: T[];
  /** Null on the last page. Opaque; hand it back verbatim. */
  nextCursor: string | null;
}

export interface BlotterOrderRow {
  id: string;
  accountId: string;
  accountNumber: string;
  ownerEmail: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  volume: string;
  filledVolume: string;
  price: string | null;
  stopPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  rejectionCode: string | null;
  placedByMasterAccountId: string | null;
  clientOrderId: string | null;
  externalOrderId: string | null;
  createdAt: string;
}

export interface BlotterPositionRow {
  id: string;
  accountId: string;
  accountNumber: string;
  ownerEmail: string;
  symbol: string;
  side: string;
  status: string;
  volume: string;
  entryPrice: string;
  currentPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  margin: string;
  commission: string;
  swap: string;
  openedAt: string;
  closedAt: string | null;
}

export interface BlotterTradeRow {
  id: string;
  accountId: string;
  accountNumber: string;
  ownerEmail: string;
  symbol: string;
  side: string;
  volume: string;
  entryPrice: string;
  exitPrice: string;
  grossPnl: string;
  commission: string;
  swap: string;
  netPnl: string;
  entryTime: string;
  exitTime: string;
}

export interface OrderEventRow {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  payload: unknown;
  createdAt: string;
}

function blotterSearch(filters: BlotterFilters): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === '') continue;
    params.set(name, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function useBlotter<T>(kind: 'orders' | 'positions' | 'trades', filters: BlotterFilters) {
  const { api } = useSession();
  const search = blotterSearch(filters);
  return useQuery({
    queryKey: adminKeys.blotter(kind, search),
    queryFn: () => api.get<BlotterPage<T>>(`/admin/${kind}${search}`),
    // A book moves; a page of it should not be stale while someone reads it.
    refetchInterval: 15_000,
  });
}

export const useBlotterOrders = (filters: BlotterFilters) =>
  useBlotter<BlotterOrderRow>('orders', filters);
export const useBlotterPositions = (filters: BlotterFilters) =>
  useBlotter<BlotterPositionRow>('positions', filters);
export const useBlotterTrades = (filters: BlotterFilters) =>
  useBlotter<BlotterTradeRow>('trades', filters);

export function useOrderHistory(id: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.orderHistory(id ?? ''),
    queryFn: () =>
      api.get<{ order: BlotterOrderRow; events: OrderEventRow[] }>(`/admin/orders/${id}/history`),
    enabled: id !== null,
  });
}

export interface SessionWindowRow {
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export interface SessionsRow {
  code: string;
  timezone: string;
  windows: SessionWindowRow[];
}

export function useInstrumentSessions(code: string | null) {
  const { api } = useSession();
  return useQuery({
    queryKey: adminKeys.sessions(code ?? ''),
    queryFn: () => api.get<SessionsRow>(`/admin/instruments/${code}/sessions`),
    enabled: code !== null,
  });
}

/** Replaces the whole week. Refused from a broker: sessions are the venue's. */
export function useSetInstrumentSessions() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      code,
      timezone,
      windows,
      reason,
    }: {
      code: string;
      timezone: string;
      windows: SessionWindowRow[];
      reason: string;
    }) =>
      api.post<SessionsRow>(
        `/admin/instruments/${code}/sessions`,
        { timezone, windows, reason },
        key(),
      ),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: adminKeys.sessions(variables.code) });
      void client.invalidateQueries({ queryKey: adminKeys.instruments });
      void client.invalidateQueries({ queryKey: adminKeys.audit('') });
    },
  });
}

// ---------------------------------------------------------------------------
// External reconciliation (§44)
// ---------------------------------------------------------------------------

export interface ReconciliationItemRow {
  id: string;
  runId: string;
  accountId: string;
  accountNumber: string;
  subject: 'BALANCE' | 'ORDER' | 'POSITION' | 'EXECUTION';
  key: string;
  status: string;
  field: string | null;
  internal: string | null;
  external: string | null;
  difference: string | null;
  tolerance: string | null;
  message: string;
  createdAt: string;
  /** Whether anybody has said anything about it yet. */
  resolutionCount: number;
}

export interface ResolutionRow {
  id: string;
  decision: string;
  note: string;
  decidedAt: string;
  decidedBy: { id: string; email: string; displayName: string | null };
}

export function useReconciliationItems(status: string) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'reconciliation-items', status],
    queryFn: () =>
      api.get<ReconciliationItemRow[]>('/reconciliation/items', {
        query: status === '' ? { limit: 200 } : { status, limit: 200 },
      }),
    enabled: accessToken !== null,
  });
}

/**
 * The decisions recorded about one discrepancy, oldest first — a history, not
 * a current value. Fetched only when somebody opens it: most items have none,
 * and asking for every item's history to render a list would be a query per row.
 */
export function useResolutions(itemId: string | null) {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'resolutions', itemId],
    queryFn: () =>
      api.get<ResolutionRow[]>('/reconciliation/resolutions', {
        query: { itemId: itemId ?? '' },
      }),
    enabled: accessToken !== null && itemId !== null,
  });
}

export function useRecordResolution() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { itemId: string; decision: string; note: string }) =>
      api.post('/reconciliation/resolutions', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin'] }),
  });
}

/** Reports: asked for here, produced by the worker, downloaded when ready. */
export interface ReportKindRow {
  kind: string;
  title: string;
  describes: string;
  permission: string;
  columns: string[];
}

export interface ReportRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  params: { fromMs?: number; toMs?: number; accountId?: string };
  requestedById: string;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  rowCount: number | null;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  filename: string;
}

export function useReportKinds() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'report-kinds'],
    queryFn: () => api.get<ReportKindRow[]>('/reports/kinds'),
    enabled: accessToken !== null,
    // The set of kinds changes when the platform is deployed, not while
    // somebody is looking at it.
    staleTime: 5 * 60_000,
  });
}

export function useReports() {
  const { api, accessToken } = useSession();
  return useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => api.get<ReportRow[]>('/reports'),
    enabled: accessToken !== null,
    /**
     * A report finishes in the worker without telling the browser. Polling is
     * the honest mechanism here: the alternative is a screen that says QUEUED
     * until somebody navigates away and back, which is how an operator
     * concludes the feature is broken.
     */
    refetchInterval: 5_000,
  });
}

export function useRequestReport() {
  const { api } = useSession();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: string; from: string; to: string; accountId?: string }) =>
      api.post<ReportRow>('/reports', input, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'reports'] }),
  });
}
