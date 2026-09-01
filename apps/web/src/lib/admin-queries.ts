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
