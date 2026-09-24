/**
 * Every typed call a client makes, made against the real API, and its answer
 * checked by the compiler against the type the client reads it as.
 *
 * `response-contracts.ts` finds the calls and does the comparing. This script
 * boots the compiled API the way `smoke-api.ts` does, gives it something to
 * answer about — a trader with an open position, a closed trade, a pending
 * order, a device, an alert, a key; an administrator with a webhook, a venue
 * connection, a master account and a report — and then makes each call:
 *
 * - with the query keys the call site sends, and no others. A client that
 *   omits a parameter the server requires is refused here exactly as it is in
 *   a user's hands, which is how the phone's positions tab was found;
 * - as a trader, or as an administrator for the desk's routes;
 * - once per call site, because two screens asking for the same path with
 *   different queries are two contracts.
 *
 * A call is then either checked, or named in `SKIPPED` with the reason it
 * cannot be made here. A call that is neither fails the run, and so does an
 * answer that is an empty list — a list with nothing in it proves nothing
 * about the rows a client reads — unless `MAY_BE_EMPTY` says why it is empty.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Permission } from '@tp/shared-types';
import { base32Decode, codeForStep, stepFor } from '../apps/api/src/auth/totp';
import { type Sample, type TypedCall, checkSamples, typedCalls } from './response-contracts';

const BASE = `http://127.0.0.1:${process.env.API_PORT ?? '4000'}`;
const API = `${BASE}/api/v1`;
const PASSWORD = 'a-sufficiently-long-passphrase';
const BOOT_TIMEOUT_MS = 60_000;

/** Calls that cannot be made by this run, and why. A reader can check each. */
export const SKIPPED: Readonly<Record<string, string>> = {
  'POST /admin/venue-recovery/unconfirmed/*/resolve':
    'needs an order a real venue accepted and never confirmed; the mock venue confirms everything',
  'POST /admin/broker-connections/*/inbox/*/replay':
    'needs an event a venue sent to the inbox; the mock venue sends none',
  'GET /reconciliation/resolutions':
    'asked for one reconciliation item, and items exist only where a real venue disagrees with the book',
};

/** Calls whose answer may be an empty list here, and why. */
export const MAY_BE_EMPTY: Readonly<Record<string, string>> = {
  'GET /integrity/signals':
    'raised only when an account trades in a pattern the detectors look for; this book is clean',
  'GET /admin/webhooks/*/deliveries':
    'a delivery is an outbound request to the endpoint, and this run registers example.com rather than send one',
  'GET /admin/broker-connections/*/inbox': 'events arrive from a venue; the mock venue sends none',
  'GET /admin/venue-recovery/unconfirmed':
    'an order a real venue accepted and never confirmed; the mock venue confirms everything',
  'GET /reconciliation/items':
    'items are where a real venue disagrees with the book; there is no real venue here',
};

/** `/admin/${kind}${search}` — the paths it takes, and the type each is read as. */
export const COMPUTED: Readonly<
  Record<string, ReadonlyArray<{ readonly path: string; readonly typeText: string }>>
> = {
  'GET /admin/**': [
    { path: '/admin/orders', typeText: 'BlotterPage<BlotterOrderRow>' },
    { path: '/admin/positions', typeText: 'BlotterPage<BlotterPositionRow>' },
    { path: '/admin/trades', typeText: 'BlotterPage<BlotterTradeRow>' },
  ],
};

/**
 * The desk's calls live in the admin query module and the admin components;
 * those are made as an administrator, everything else as the trader. By file,
 * not by path: a trader's screen that called an admin route would be refused
 * here, as it is in the trader's hands.
 */
const isStaffCall = (call: TypedCall) => /(^|\/)admin[-/]/.test(call.file);

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

class Refused extends Error {}

async function request(
  token: string | null,
  verb: string,
  path: string,
  options: {
    body?: unknown;
    raw?: Buffer;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<unknown> {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: verb,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(verb === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.raw === undefined ? {} : { body: new Uint8Array(options.raw) }),
  });
  const text = await response.text();
  let envelope: Envelope;
  try {
    envelope = JSON.parse(text) as Envelope;
  } catch {
    throw new Refused(`${verb} ${url.pathname}${url.search} answered ${response.status}, not JSON`);
  }
  if (!response.ok || envelope.ok !== true) {
    throw new Refused(
      `${verb} ${url.pathname}${url.search} answered ${response.status} ${envelope.error?.code ?? ''}: ${envelope.error?.message ?? text.slice(0, 200)}`,
    );
  }
  return envelope.data;
}

async function register(prisma: PrismaClient, label: string, role?: string) {
  const email = `contracts-${label}-${Date.now()}@test.local`;
  await request(null, 'POST', '/auth/register', {
    body: { email, password: PASSWORD, displayName: `Contracts ${label}` },
  }).catch((error: unknown) => {
    // Registration answers 202 with a body some deployments leave empty.
    if (!(error instanceof Refused) || !/answered 202/.test(error.message)) throw error;
  });
  const user = await prisma.user.findFirstOrThrow({ where: { email } });
  if (role !== undefined) {
    await prisma.user.update({ where: { id: user.id }, data: { role: role as never } });
  }
  return { email, userId: user.id };
}

async function waitForBoot(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`API did not become healthy within ${BOOT_TIMEOUT_MS}ms`);
}

/** Recorded answers to the calls setup makes, by `VERB /path` and, where it differs, app. */
class Answers {
  private readonly byKey = new Map<string, unknown>();
  record(key: string, data: unknown, app?: TypedCall['app']): unknown {
    this.byKey.set(app === undefined ? key : `${app} ${key}`, data);
    return data;
  }
  for(call: TypedCall): { found: boolean; data: unknown } {
    for (const key of [`${call.app} ${call.key}`, call.key]) {
      if (this.byKey.has(key)) return { found: true, data: this.byKey.get(key) };
    }
    return { found: false, data: undefined };
  }
}

interface World {
  trader: string;
  admin: string;
  traderId: string;
  adminId: string;
  accountId: string;
  ids: Record<string, string>;
}

const first = <T>(list: unknown, what: string): T => {
  const row = (Array.isArray(list) ? list[0] : undefined) as T | undefined;
  if (row === undefined) throw new Error(`setup: no ${what}`);
  return row;
};

/** A 1×1 PNG: the smallest file the KYC upload accepts as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function signIn(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const answer = (await request(null, 'POST', '/auth/login', {
    body: { email, password: PASSWORD, ...extra },
  })) as { accessToken: string };
  return answer.accessToken;
}

async function freshQuote(token: string, symbol: string) {
  // The API answers /health before the simulator's first tick; wait for a fresh price.
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(500)) {
    const quotes = (await request(token, 'GET', '/market/quotes')) as Array<{
      symbol: string;
      bid: string;
      timestamp: number;
    }>;
    const quote = quotes.find((q) => q.symbol === symbol && Date.now() - q.timestamp < 2_000);
    if (quote !== undefined) return quote;
  }
  throw new Error(`setup: no fresh ${symbol} quote within 20s`);
}

async function setUp(prisma: PrismaClient, answers: Answers): Promise<World> {
  const ids: Record<string, string> = {};
  const trader = await register(prisma, 'trader');
  const admin = await register(prisma, 'admin', 'PLATFORM_SUPER_ADMIN');
  const guarded = await register(prisma, 'guarded');
  // Money out is reviewed by finance and nobody else — not even the super administrator.
  const finance = await register(prisma, 'finance', 'FINANCE');

  // --- Signing in: the phone as a native client, the browser as a browser.
  const nativeLogin = (await request(null, 'POST', '/auth/login', {
    body: { email: trader.email, password: PASSWORD, installationId: 'contracts-phone-0001' },
  })) as { accessToken: string };
  answers.record('POST /auth/login', nativeLogin, 'mobile');
  answers.record(
    'POST /auth/login',
    await request(null, 'POST', '/auth/login', {
      body: { email: trader.email, password: PASSWORD },
      headers: { Origin: 'http://localhost:3000' },
    }),
    'web',
  );
  const traderToken = nativeLogin.accessToken;
  const adminToken = await signIn(admin.email);
  const guardedToken = await signIn(guarded.email);
  const financeToken = await signIn(finance.email);
  const as = {
    trader: (verb: string, path: string, body?: unknown) =>
      request(traderToken, verb, path, body === undefined ? {} : { body }),
    admin: (verb: string, path: string, body?: unknown) =>
      request(adminToken, verb, path, body === undefined ? {} : { body }),
    guarded: (verb: string, path: string, body?: unknown) =>
      request(guardedToken, verb, path, body === undefined ? {} : { body }),
    finance: (verb: string, path: string, body?: unknown) =>
      request(financeToken, verb, path, body === undefined ? {} : { body }),
  };

  const accountId = first<{ id: string }>(await as.trader('GET', '/accounts'), 'account').id;
  const guardedAccount = first<{ id: string }>(await as.guarded('GET', '/accounts'), 'account').id;

  await as.trader('POST', '/devices', {
    platform: 'IOS',
    installationId: 'contracts-phone-0001',
    pushToken: 'ExponentPushToken[contracts-0000000000]',
    model: 'iPhone 15',
    appVersion: '1.0.0',
  });

  // --- Trading: an open position, a closed trade, a resting order.
  const eurusd = await freshQuote(traderToken, 'EURUSD');
  await freshQuote(traderToken, 'GBPUSD');
  const order = { accountId, symbol: 'EURUSD', side: 'BUY', volume: '0.10' };
  answers.record('POST /orders/preview', await as.trader('POST', '/orders/preview', order));
  const ack = answers.record('POST /orders', await as.trader('POST', '/orders', order)) as {
    orderId: string;
  };
  ids['order'] = ack.orderId;
  await as.trader('POST', '/orders', { accountId, symbol: 'GBPUSD', side: 'SELL', volume: '0.10' });
  const open = (await request(traderToken, 'GET', '/positions', {
    query: { accountId },
  })) as Array<{
    id: string;
    symbol: string;
  }>;
  const gbp = open.find((position) => position.symbol === 'GBPUSD');
  if (gbp === undefined) throw new Error('setup: the GBPUSD position did not open');
  await as.trader('POST', `/positions/${gbp.id}/close`, {});
  answers.record(
    'POST /orders/pending',
    await as.trader('POST', '/orders/pending', {
      accountId,
      symbol: 'EURUSD',
      side: 'BUY',
      type: 'LIMIT',
      volume: '0.10',
      price: (Number(eurusd.bid) * 0.9).toFixed(5),
    }),
  );
  // close-all, on somebody else's book so the trader's stays open to be read.
  await as.guarded('POST', '/orders', { ...order, accountId: guardedAccount });
  answers.record(
    'POST /positions/close-all',
    await as.guarded('POST', '/positions/close-all', { accountId: guardedAccount }),
  );

  // --- The trader's other things.
  const alertBody = {
    symbol: 'EURUSD',
    condition: 'ABOVE',
    price: (Number(eurusd.bid) * 1.2).toFixed(5),
  };
  answers.record('POST /alerts', await as.trader('POST', '/alerts', alertBody));
  const doomed = (await as.trader('POST', '/alerts', alertBody)) as { id: string };
  answers.record('DELETE /alerts/*', await as.trader('DELETE', `/alerts/${doomed.id}`));
  const key = answers.record(
    'POST /api-keys',
    await as.trader('POST', '/api-keys', {
      name: 'contracts',
      permissions: ['accounts.read'],
      password: PASSWORD,
    }),
  ) as { key: { id: string } };
  const secondKey = (await as.trader('POST', '/api-keys', {
    name: 'contracts two',
    permissions: ['accounts.read'],
    password: PASSWORD,
  })) as { key: { id: string } };
  answers.record(
    'POST /api-keys/*/revoke',
    await as.trader('POST', `/api-keys/${secondKey.key.id}/revoke`, {}),
  );
  answers.record(
    'POST /charts/layouts',
    await as.trader('POST', '/charts/layouts', {
      name: 'contracts',
      symbol: 'EURUSD',
      resolution: '1',
      accountId,
      content: { panes: [] },
    }),
  );

  // --- Money in: a payment the desk settles, a wallet, a transfer.
  const providers = (await as.trader('GET', '/payments/providers')) as { providers: string[] };
  const payment = answers.record(
    'POST /payments',
    await as.trader('POST', '/payments', {
      provider: first<string>(providers.providers, 'payment provider'),
      amount: '250.00',
      currency: 'USD',
    }),
  ) as { id: string };
  ids['payment'] = payment.id;
  answers.record(
    'POST /admin/payments/*/settle',
    await as.admin('POST', `/admin/payments/${payment.id}/settle`, {
      outcome: 'SUCCEEDED',
      reason: 'contracts: confirmed by hand',
    }),
  );
  const wallets = (await as.trader('GET', '/wallet')) as { wallets: Array<{ id: string }> };
  ids['wallet'] = first<{ id: string }>(wallets.wallets, 'wallet').id;
  answers.record(
    'POST /wallet/transfer',
    await as.trader('POST', '/wallet/transfer', {
      accountId,
      direction: 'to-wallet',
      amount: '10.00',
    }),
  );

  // --- Identity: two documents, a submission, a reviewer's whole path.
  for (const kind of ['passport', 'selfie']) {
    answers.record(
      'PUT /kyc/documents/*',
      await request(traderToken, 'PUT', `/kyc/documents/${kind}`, {
        raw: PNG,
        headers: { 'Content-Type': 'image/png', 'X-Filename': `${kind}.png` },
      }),
    );
  }
  answers.record('POST /kyc/submit', await as.trader('POST', '/kyc/submit', {}));
  const kycCase = await prisma.kycRecord.findFirstOrThrow({ where: { userId: trader.userId } });
  ids['kyc'] = kycCase.id;
  answers.record(
    'POST /admin/kyc/*/claim',
    await as.admin('POST', `/admin/kyc/${kycCase.id}/claim`, {}),
  );
  answers.record(
    'POST /admin/kyc/*/release',
    await as.admin('POST', `/admin/kyc/${kycCase.id}/release`, {}),
  );
  await as.admin('POST', `/admin/kyc/${kycCase.id}/claim`, {});
  answers.record(
    'POST /admin/kyc/*/decide',
    await as.admin('POST', `/admin/kyc/${kycCase.id}/decide`, {
      outcome: 'VERIFIED',
      reason: 'contracts: documents match',
    }),
  );

  // --- Money out: one withdrawal paid end to end, one cancelled.
  const withdrawal = answers.record(
    'POST /withdrawals',
    await as.trader('POST', '/withdrawals', {
      walletId: ids['wallet'],
      amount: '20.00',
      destination: 'IBAN GB00 CONT RACT 0000 0000 00',
    }),
  ) as { id: string };
  ids['withdrawal'] = withdrawal.id;
  const cancelled = (await as.trader('POST', '/withdrawals', {
    walletId: ids['wallet'],
    amount: '10.00',
    destination: 'IBAN GB00 CONT RACT 0000 0000 00',
  })) as { id: string };
  answers.record(
    'POST /withdrawals/*/cancel',
    await as.trader('POST', `/withdrawals/${cancelled.id}/cancel`, {}),
  );
  const w = `/admin/withdrawals/${withdrawal.id}`;
  answers.record('POST /admin/withdrawals/*/claim', await as.finance('POST', `${w}/claim`, {}));
  answers.record('POST /admin/withdrawals/*/release', await as.finance('POST', `${w}/release`, {}));
  await as.finance('POST', `${w}/claim`, {});
  answers.record(
    'POST /admin/withdrawals/*/decide',
    await as.finance('POST', `${w}/decide`, { outcome: 'APPROVED', reason: 'contracts: approved' }),
  );
  answers.record(
    'GET /admin/withdrawals/*/destination',
    await as.finance('GET', `${w}/destination`),
  );
  answers.record(
    'POST /admin/withdrawals/*/payout',
    await as.finance('POST', `${w}/payout`, { providerReference: 'contracts-ref-1' }),
  );
  answers.record(
    'POST /admin/withdrawals/*/settle',
    await as.finance('POST', `${w}/settle`, { outcome: 'PAID', reason: 'contracts: paid' }),
  );
  answers.record(
    'POST /admin/kyc/*/revoke',
    await as.admin('POST', `/admin/kyc/${kycCase.id}/revoke`, {
      reason: 'contracts: revoked to exercise the route',
    }),
  );

  // --- The desk.
  const hook = answers.record(
    'POST /admin/webhooks',
    await as.admin('POST', '/admin/webhooks', {
      url: 'https://example.com/contracts',
      description: 'contracts',
      events: [],
    }),
  ) as { endpoint: { id: string } };
  ids['webhook'] = hook.endpoint.id;
  answers.record(
    'POST /admin/webhooks/*/rotate-secret',
    await as.admin('POST', `/admin/webhooks/${hook.endpoint.id}/rotate-secret`, {}),
  );

  const connection = answers.record(
    'POST /admin/broker-connections',
    await as.admin('POST', '/admin/broker-connections', {
      name: `contracts ${Date.now()}`,
      adapterKind: 'MOCK',
    }),
  ) as { id: string };
  ids['connection'] = connection.id;
  const c = `/admin/broker-connections/${connection.id}`;
  answers.record(
    'POST /admin/broker-connections/*/credentials',
    await as.admin('POST', `${c}/credentials`, {
      kind: 'LOGIN_PASSWORD_SERVER',
      fields: { login: '1001', password: 'contracts-venue-secret', server: 'Mock-Live' },
    }),
  );
  answers.record('POST /admin/broker-connections/*/test', await as.admin('POST', `${c}/test`, {}));
  const catalogue = (await as.admin('GET', `${c}/catalogue`)) as {
    instruments: Array<{ externalSymbol?: string; symbol?: string }>;
  };
  const external = first<{ externalSymbol?: string; symbol?: string }>(
    catalogue.instruments,
    'venue instrument',
  );
  answers.record(
    'POST /admin/broker-connections/*/mappings',
    await as.admin('POST', `${c}/mappings`, {
      symbolCode: 'EURUSD',
      externalSymbol: external.externalSymbol ?? external.symbol ?? 'EURUSD',
    }),
  );
  answers.record(
    'POST /admin/broker-connections/*/mappings/enabled',
    await as.admin('POST', `${c}/mappings/enabled`, { symbolCode: 'EURUSD', enabled: true }),
  );
  answers.record(
    'POST /admin/broker-connections/*/mappings/sync',
    await as.admin('POST', `${c}/mappings/sync`, {}),
  );
  answers.record(
    'POST /admin/broker-connections/*/enabled',
    await as.admin('POST', `${c}/enabled`, { enabled: false, reason: 'contracts: parked' }),
  );
  await as.admin('POST', `${c}/enabled`, { enabled: true, reason: 'contracts: back in service' });

  const master = answers.record(
    'POST /master-accounts',
    await as.admin('POST', '/master-accounts', {
      operatorUserId: admin.userId,
      name: `contracts ${Date.now()}`,
    }),
  ) as { id: string };
  ids['master'] = master.id;
  answers.record(
    'POST /master-accounts/*/links',
    await as.admin('POST', `/master-accounts/${master.id}/links`, {
      accountId,
      role: 'MASTER_VIEWER',
    }),
  );
  await as.admin('POST', `/master-accounts/${master.id}/links`, {
    accountId: guardedAccount,
    role: 'MASTER_VIEWER',
  });
  answers.record(
    'DELETE /master-accounts/*/links/*',
    await as.admin('DELETE', `/master-accounts/${master.id}/links/${guardedAccount}`),
  );

  // Risk limits at each level, written back exactly as they stand.
  const limits = (await as.admin('GET', '/admin/risk/limits')) as Array<Record<string, unknown>>;
  const standing = (level: string) => {
    const row = limits.find((candidate) => candidate['level'] === level);
    return {
      maxPositionVolume: (row?.['maxPositionVolume'] as string | null | undefined) ?? null,
      maxOpenPositions: (row?.['maxOpenPositions'] as number | null | undefined) ?? null,
      maxGrossNotional: (row?.['maxGrossNotional'] as string | null | undefined) ?? null,
      maxSymbolNetVolume: (row?.['maxSymbolNetVolume'] as string | null | undefined) ?? null,
    };
  };
  for (const level of ['platform', 'broker']) {
    answers.record(
      'POST /admin/risk/limits/*',
      await as.admin('POST', `/admin/risk/limits/${level}`, standing(level.toUpperCase())),
    );
  }
  answers.record(
    'POST /admin/risk/limits/desk/*',
    await as.admin('POST', `/admin/risk/limits/desk/${master.id}`, standing('DESK')),
  );

  const kinds = (await as.admin('GET', '/reports/kinds')) as Array<{ kind: string }>;
  const today = new Date().toISOString().slice(0, 10);
  answers.record(
    'POST /reports',
    await as.admin('POST', '/reports', {
      kind: first<{ kind: string }>(kinds, 'report kind').kind,
      from: today,
      to: today,
    }),
  );
  answers.record('POST /reconciliation/runs', await as.admin('POST', '/reconciliation/runs', {}));

  // Instruments: a symbol nobody here trades is switched off and on, its
  // terms and sessions written back as they are.
  const quiet = 'AUDUSD';
  answers.record(
    'POST /admin/instruments/*/enabled',
    await as.admin('POST', `/admin/instruments/${quiet}/enabled`, {
      enabled: false,
      reason: 'contracts: exercising the switch',
    }),
  );
  await as.admin('POST', `/admin/instruments/${quiet}/enabled`, {
    enabled: true,
    reason: 'contracts: and back again',
  });
  const symbol = (await as.trader('GET', `/symbols/${quiet}`)) as { maxVolume: string };
  answers.record(
    'POST /admin/instruments/*/terms',
    await as.admin('POST', `/admin/instruments/${quiet}/terms`, {
      maxVolume: symbol.maxVolume,
      reason: 'contracts: unchanged terms',
    }),
  );
  const sessions = (await as.admin('GET', `/admin/instruments/${quiet}/sessions`)) as {
    timezone: string;
    windows: unknown[];
  };
  answers.record(
    'POST /admin/instruments/*/sessions',
    await as.admin('POST', `/admin/instruments/${quiet}/sessions`, {
      timezone: sessions.timezone,
      windows: sessions.windows,
      reason: 'contracts: unchanged sessions',
    }),
  );

  // Roles and people.
  const roles = (await as.admin('GET', '/permissions/roles')) as {
    roles: Array<{ key: string; permissions: string[] }>;
  };
  const support = roles.roles.find((role) => role.key === 'SUPPORT');
  if (support === undefined) throw new Error('setup: no SUPPORT role');
  answers.record(
    'PUT /permissions/roles/*',
    await as.admin('PUT', '/permissions/roles/SUPPORT', { permissions: support.permissions }),
  );
  answers.record(
    'POST /permissions/roles/*/reset',
    await as.admin('POST', '/permissions/roles/SUPPORT/reset', {}),
  );
  answers.record(
    'POST /admin/api-keys/*/revoke',
    await as.admin('POST', `/admin/api-keys/${key.key.id}/revoke`, {
      reason: 'contracts: revoked',
    }),
  );
  const minted = answers.record(
    'POST /admin/service-tokens',
    await as.admin('POST', '/admin/service-tokens', {
      name: 'contracts',
      permissions: [Permission.ACCOUNTS_READ_ANY],
    }),
  ) as { token: { id: string } };
  answers.record(
    'POST /admin/service-tokens/*/revoke',
    await as.admin('POST', `/admin/service-tokens/${minted.token.id}/revoke`, {
      reason: 'contracts: revoked',
    }),
  );
  const broker = answers.record(
    'POST /admin/brokers',
    await as.admin('POST', '/admin/brokers', {
      slug: `contracts-${Date.now()}`,
      name: 'Contracts Broker',
    }),
  ) as { broker?: { id: string }; id?: string };
  ids['broker'] = broker.broker?.id ?? broker.id ?? '';
  answers.record(
    'POST /admin/brokers/*/status',
    await as.admin('POST', `/admin/brokers/${ids['broker']}/status`, {
      status: 'SUSPENDED',
      reason: 'contracts: suspended',
    }),
  );

  // Two-factor: the guarded person enrols, activates, and is challenged.
  const offer = answers.record(
    'POST /auth/2fa/enrol',
    await as.guarded('POST', '/auth/2fa/enrol'),
  ) as { secret: string };
  const secret = base32Decode(offer.secret);
  answers.record(
    'POST /auth/2fa/activate',
    await as.guarded('POST', '/auth/2fa/activate', {
      code: codeForStep(secret, stepFor(Date.now())),
    }),
  );
  const challenge = (await request(null, 'POST', '/auth/login', {
    body: { email: guarded.email, password: PASSWORD },
  })) as { challengeToken: string };
  answers.record(
    'POST /auth/login/2fa',
    await request(null, 'POST', '/auth/login/2fa', {
      body: {
        challengeToken: challenge.challengeToken,
        code: codeForStep(secret, stepFor(Date.now()) + 1),
      },
    }),
  );
  answers.record(
    'POST /admin/users/*/role',
    await as.admin('POST', `/admin/users/${guarded.userId}/role`, {
      role: 'SUPPORT',
      reason: 'contracts: role change',
    }),
  );

  // The adjustment needs the administrator's own second factor.
  const adminOffer = (await as.admin('POST', '/auth/2fa/enrol')) as { secret: string };
  const adminSecret = base32Decode(adminOffer.secret);
  await as.admin('POST', '/auth/2fa/activate', {
    code: codeForStep(adminSecret, stepFor(Date.now())),
  });
  answers.record(
    'POST /admin/accounts/*/adjustments',
    await as.admin('POST', `/admin/accounts/${accountId}/adjustments`, {
      amount: '1.00',
      type: 'ADJUSTMENT',
      reason: 'contracts: a one-unit adjustment',
      totpCode: codeForStep(adminSecret, stepFor(Date.now()) + 1),
    }),
  );

  // Notifications are written by the worker from the outbox: wait for them.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(1_000)) {
    const notices = (await request(traderToken, 'GET', '/notifications')) as unknown[];
    if (notices.length > 0) break;
  }

  return {
    trader: traderToken,
    admin: adminToken,
    traderId: trader.userId,
    adminId: admin.userId,
    accountId,
    ids,
  };
}

/** Query values that depend on which list is asked: each queue's own statuses. */
const QUERY_BY_CALL: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'GET /admin/kyc': { status: 'VERIFIED' },
  'GET /admin/payments': { status: 'SUCCEEDED' },
  'GET /admin/withdrawals': { status: 'PAID' },
};

/** A value for each query key a call site sends without writing a literal. */
function queryValue(name: string, world: World, key: string): string {
  const specific = QUERY_BY_CALL[key]?.[name];
  if (specific !== undefined) return specific;
  const now = Date.now();
  const values: Record<string, string> = {
    accountId: world.accountId,
    symbol: 'EURUSD',
    resolution: '1',
    // Milliseconds, as both chart clients send them.
    from: String(now - 86_400_000),
    to: String(now),
    includeClosed: 'true',
    currency: 'USD',
    limit: '100',
  };
  const value = values[name] ?? world.ids[name];
  if (value === undefined) throw new Error(`no value for the query key "${name}"`);
  return value;
}

/** Path parameters, in order, for each call whose path has them. */
function pathValues(key: string, world: World): string[] | undefined {
  const table: Record<string, string[]> = {
    'GET /accounts/*/state': [world.accountId],
    'GET /accounts/*/settings': [world.accountId],
    'GET /symbols/*': ['EURUSD'],
    'GET /admin/users/*': [world.traderId],
    'GET /admin/users/*/devices': [world.traderId],
    'GET /admin/accounts/*': [world.accountId],
    'GET /admin/broker-connections/*/mappings': [world.ids['connection']!],
    'GET /admin/broker-connections/*/catalogue': [world.ids['connection']!],
    'GET /admin/broker-connections/*/inbox': [world.ids['connection']!],
    'GET /admin/payments/*/events': [world.ids['payment']!],
    'GET /admin/kyc/*': [world.ids['kyc']!],
    'GET /admin/brokers/*/features': [world.ids['broker']!],
    'GET /admin/webhooks/*/deliveries': [world.ids['webhook']!],
    'GET /admin/orders/*/history': [world.ids['order']!],
    'GET /wallet/*/transactions': [world.ids['wallet']!],
    'GET /master-accounts/*/links': [world.ids['master']!],
    'GET /master-accounts/*/desk': [world.ids['master']!],
    'GET /admin/instruments/*/sessions': ['EURUSD'],
  };
  return table[key];
}

async function main(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    throw new Error(`Something is already listening on ${BASE}. Stop it first.`);
  } catch (error) {
    if ((error as Error).message.startsWith('Something')) throw error;
  }
  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RATE_LIMIT_LOGIN_PER_MINUTE: '30', LOG_LEVEL: 'warn' },
  });
  const output: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  // The worker writes notifications, push deliveries and the schedules' rows.
  const worker = spawn('node', ['apps/worker/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'warn' },
  });
  worker.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  worker.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const prisma = new PrismaClient();
  try {
    await waitForBoot();
    const answers = new Answers();
    const world = await setUp(prisma, answers);
    const failures: string[] = [];
    const samples: Sample[] = [];
    const empty: string[] = [];
    const cache = new Map<string, unknown>();

    for (const call of typedCalls()) {
      const where = `${call.key}  (${call.file}:${call.line})`;
      if (SKIPPED[call.key] !== undefined) continue;
      const recorded = answers.for(call);
      if (recorded.found) {
        samples.push({ call, data: recorded.data });
        continue;
      }
      if (call.verb !== 'GET') {
        failures.push(`${where}: neither made by setup nor listed in SKIPPED`);
        continue;
      }
      const targets = COMPUTED[call.key] ?? [{ path: call.path, typeText: call.typeText }];
      for (const target of targets) {
        let path = target.path;
        if (path.includes('*')) {
          const values = pathValues(call.key, world);
          if (values === undefined) {
            failures.push(`${where}: no path parameters for it and not in SKIPPED`);
            continue;
          }
          for (const value of values) path = path.replace('*', encodeURIComponent(value));
        }
        const token = isStaffCall(call) ? world.admin : world.trader;
        try {
          const query: Record<string, string> = {};
          for (const [name, literal] of Object.entries(call.query ?? {})) {
            query[name] = literal ?? queryValue(name, world, call.key);
          }
          const cacheKey = `${token === world.admin ? 'A' : 'T'} ${path}?${new URLSearchParams(query)}`;
          const data = cache.has(cacheKey)
            ? cache.get(cacheKey)
            : await request(token, 'GET', path, { query });
          cache.set(cacheKey, data);
          samples.push({ call: { ...call, typeText: target.typeText }, data });
          if (isEmptyList(data) && MAY_BE_EMPTY[call.key] === undefined) {
            empty.push(`${where}: answered an empty list`);
          }
        } catch (error) {
          failures.push(`${where}: ${(error as Error).message}`);
        }
      }
    }

    for (const mismatch of checkSamples(samples)) {
      failures.push(
        `${mismatch.call.key}  (${mismatch.call.file}:${mismatch.call.line}) reads ${mismatch.call.typeText}:\n      ${mismatch.message.replace(/\n/g, '\n      ')}`,
      );
    }
    failures.push(...empty);

    for (const failure of failures) console.error(`  FAIL ${failure}`);
    if (failures.length > 0) {
      console.error(
        `\n${failures.length} contract failure(s) across ${samples.length} checked answers.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${samples.length} answers are what their clients read them as.`);
    }
  } catch (error) {
    console.error(output.join('').slice(-4000));
    throw error;
  } finally {
    await prisma.$disconnect();
    api.kill('SIGTERM');
    worker.kill('SIGTERM');
  }
}

/** A list, or an object whose only list is empty (`{ keys: [] }`). */
function isEmptyList(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data !== 'object' || data === null) return false;
  const values = Object.values(data);
  return values.length === 1 && Array.isArray(values[0]) && values[0].length === 0;
}

if (process.argv[1]?.endsWith('smoke-contracts.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
