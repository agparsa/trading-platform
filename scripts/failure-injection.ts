/**
 * Failure injection (§75).
 *
 * The question this answers is not "does the platform stay up" — it is "does
 * the money stay right". Each scenario breaks something underneath a running
 * API while orders are in flight, restores it, and then checks the one
 * invariant a trading platform must never lose, however it was treated:
 *
 *   every account's balance equals the sum of its own ledger, and every order
 *   that was accepted produced exactly one position — never none, never two.
 *
 * Latency is printed. Only the invariant, and a response that is not a coded
 * envelope, fail the run. A slow order under a severed database is capacity; a
 * doubled fill is a defect.
 *
 * Postgres and Redis are reached through a small TCP proxy this script runs,
 * which is what lets it add latency, sever every connection mid-transaction,
 * or refuse connections entirely, without touching either server. The API
 * itself is the compiled build, killed with SIGKILL where a scenario needs it —
 * a process that is asked nicely to stop is not the failure being tested.
 *
 * Run with `pnpm chaos` after `pnpm build`. Needs the same .env as smoke.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const PORT = process.env['CHAOS_API_PORT'] ?? '4300';
const INGEST_PORT = process.env['CHAOS_INGEST_PORT'] ?? '4301';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'a-sufficiently-long-passphrase';
const BURST = Number(process.env['CHAOS_BURST'] ?? '40');
const KILL_AFTER_MS = Number(process.env['CHAOS_KILL_AFTER_MS'] ?? '1200');
/** The shortest the platform allows; a harness cannot wait five minutes per scenario. */
const TAKEOVER_MS = 10_000;

const SAFE_REFUSALS = new Set([
  'STALE_QUOTE',
  'NO_QUOTE_AVAILABLE',
  'TRADING_HALTED',
  'MARKET_CLOSED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'IDEMPOTENCY_RESULT_UNAVAILABLE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
]);

// ---- the proxy --------------------------------------------------------------

class Proxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  latencyMs = 0;
  refuse = false;
  /** Client→upstream writes. For Postgres, roughly one per statement: a round-trip count. */
  messages = 0;

  constructor(
    readonly name: string,
    private readonly listenPort: number,
    private readonly upstreamPort: number,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((client) => {
      if (this.refuse) {
        client.destroy();
        return;
      }
      const upstream = connect(this.upstreamPort, '127.0.0.1');
      this.sockets.add(client);
      this.sockets.add(upstream);
      const forward = (from: Socket, to: Socket) => {
        from.on('data', (chunk: Buffer) => {
          if (from === client) this.messages += 1;
          if (this.latencyMs > 0)
            setTimeout(() => !to.destroyed && to.write(chunk), this.latencyMs);
          else to.write(chunk);
        });
        from.on('end', () => setTimeout(() => to.end(), this.latencyMs));
        from.on('error', () => to.destroy());
        from.on('close', () => {
          this.sockets.delete(from);
          to.destroy();
        });
      };
      forward(client, upstream);
      forward(upstream, client);
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(this.listenPort, '127.0.0.1', resolve),
    );
  }

  /** Every live connection dies now, mid-whatever it was doing. */
  sever(): number {
    const count = this.sockets.size;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return count;
  }

  async stop(): Promise<void> {
    this.sever();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

// ---- helpers -----------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Through the proxy, and with a small pool. Two API instances each open one
 * pool per tenant they serve (`DATABASE_URL_TENANT`), and a local Postgres
 * allows a hundred connections; the default pool size of `2 × cores + 1` per
 * tenant per instance runs into that ceiling on a machine that has seen a few
 * pentest tenants. The pool size is not what this harness measures.
 */
function rewritePort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(port);
  parsed.searchParams.set('connection_limit', '2');
  return parsed.toString();
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function call<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: Envelope<T> | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  try {
    const response = await fetch(`${BASE}/api/v1${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: Envelope<T> | null = null;
    try {
      body = JSON.parse(text) as Envelope<T>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: { ok: false, error: { code: 'TRANSPORT', message: String(error) } } };
  }
}

interface Trader {
  token: string;
  accountId: string;
  email: string;
}

async function registerTrader(index: number): Promise<Trader> {
  const email = `chaos-${Date.now()}-${index}@test.local`;
  await call('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Chaos ${index}` }),
  });
  const login = await call<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const token = login.body?.data?.accessToken;
  if (token === undefined)
    throw new Error(`could not sign in ${email}: ${JSON.stringify(login.body)}`);
  const accounts = await call<Array<{ id: string }>>('/accounts', { token });
  const accountId = accounts.body?.data?.[0]?.id;
  if (accountId === undefined) throw new Error('registration opened no account');
  return { token, accountId, email };
}

interface OrderAttempt {
  key: string;
  status: number;
  code: string | null;
  ms: number;
  ok: boolean;
}

async function placeOrder(trader: Trader, key: string): Promise<OrderAttempt> {
  const started = Date.now();
  const result = await call<{ id: string }>('/orders', {
    method: 'POST',
    token: trader.token,
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.01',
    }),
  });
  return {
    key,
    status: result.status,
    code: result.body?.error?.code ?? null,
    ms: Date.now() - started,
    ok: result.status === 201 && result.body?.ok === true,
  };
}

async function burst(traders: Trader[], keys: string[]): Promise<OrderAttempt[]> {
  return Promise.all(keys.map((key, index) => placeOrder(traders[index % traders.length]!, key)));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summarise(label: string, attempts: OrderAttempt[]): void {
  const filled = attempts.filter((a) => a.ok).length;
  const refused = attempts.filter((a) => !a.ok);
  const codes = new Map<string, number>();
  for (const attempt of refused) {
    const code = attempt.code ?? `HTTP ${attempt.status}`;
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  const ms = attempts.map((a) => a.ms);
  console.log(
    `    ${label}: ${filled} filled, ${refused.length} refused` +
      (codes.size > 0 ? ` (${[...codes].map(([c, n]) => `${c}×${n}`).join(', ')})` : '') +
      ` · p50 ${percentile(ms, 50)} ms · p95 ${percentile(ms, 95)} ms · max ${Math.max(...ms, 0)} ms`,
  );
}

/** A refusal must be a *coded* refusal, or a transport failure while the platform was down. */
function assertCoded(attempts: OrderAttempt[], allowTransport: boolean): void {
  for (const attempt of attempts) {
    if (attempt.ok) continue;
    if (attempt.status === 0 && allowTransport) continue;
    if (attempt.code !== null && (SAFE_REFUSALS.has(attempt.code) || attempt.status < 500))
      continue;
    if (attempt.code !== null && attempt.status >= 500) continue; // coded 5xx envelope: acceptable, not silent
    throw new Error(
      `an order was refused without a coded envelope: HTTP ${attempt.status}, code ${attempt.code}`,
    );
  }
}

// ---- the invariant -------------------------------------------------------------

async function checkInvariant(
  prisma: PrismaClient,
  traders: Trader[],
  keys: string[],
  label: string,
): Promise<void> {
  const accountIds = traders.map((t) => t.accountId);
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, number: true, balance: true },
  });
  let drifted = 0;
  for (const account of accounts) {
    const [row] = await prisma.$queryRaw<Array<{ total: string | null }>>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM balance_ledger WHERE account_id = ${account.id}::uuid
    `;
    if (Number(row?.total ?? '0') !== Number(account.balance)) {
      drifted += 1;
      console.error(
        `      ${account.number}: balance ${account.balance.toString()} ≠ ledger ${row?.total}`,
      );
    }
  }

  /**
   * One fill per accepted order, found by the idempotency key the order was
   * placed with. Two executions for one order is the doubled fill the whole
   * harness exists to catch; a stored result naming a position that does not
   * exist is the other half of the same defect.
   */
  /**
   * COMPLETED, or COMMITTED: a claim the transaction marked as it committed and
   * the crash left without a result. Both are applied. The second is what a
   * retry is refused with `IDEMPOTENCY_RESULT_UNAVAILABLE` for, and it is
   * counted here as a fill that exists rather than as one that is missing.
   */
  const claims = await prisma.idempotencyKey.findMany({
    where: { key: { in: keys }, status: { in: ['COMPLETED', 'COMMITTED'] } },
    select: { key: true, status: true, responseBody: true },
  });
  const committedOnly = claims.filter((c) => c.status === 'COMMITTED').length;
  const results = claims
    .filter((claim) => claim.status === 'COMPLETED')
    .map((claim) => claim.responseBody as { orderId?: string; positionId?: string | null } | null)
    .filter(
      (r): r is { orderId: string; positionId: string | null } => typeof r?.orderId === 'string',
    );
  const orderIds = results.map((r) => r.orderId);
  const fills = await prisma.execution.groupBy({
    by: ['orderId'],
    where: { orderId: { in: orderIds } },
    _count: { _all: true },
  });
  const doubled = fills.filter((f) => f._count._all > 1);
  const missing = orderIds.filter((id) => !fills.some((f) => f.orderId === id));
  /**
   * Fills nobody can retry safely. A claim left IN_PROGRESS by a crash whose
   * order transaction had already committed is a fill with no completed
   * idempotency record: the client's retry with the same key is refused as
   * "still in flight" until the key expires, and a retry with a fresh key
   * would fill again. Counted by comparing every fill on these accounts with
   * the completed claims — the gap is exactly those orphans.
   */
  const fillsOnAccounts = await prisma.execution.count({
    where: { accountId: { in: accountIds } },
  });
  const orphaned = await prisma.idempotencyKey.count({
    where: { key: { in: keys }, status: 'IN_PROGRESS' },
  });

  const positionIds = results
    .map((r) => r.positionId)
    .filter((id): id is string => typeof id === 'string');
  const positionsPresent = await prisma.position.count({ where: { id: { in: positionIds } } });
  if (positionsPresent !== positionIds.length) {
    throw new Error(
      `${positionIds.length - positionsPresent} accepted order(s) name a position that does not exist`,
    );
  }

  console.log(
    `    invariant after ${label}: ${accounts.length} accounts, ${drifted} drifted · ` +
      `${claims.length} accepted orders, ${doubled.length} filled twice, ${missing.length} never filled · ` +
      `${fillsOnAccounts} fills in all, ${committedOnly} applied without a recorded result, ${orphaned} claim(s) left in flight`,
  );
  if (fillsOnAccounts > claims.length) {
    console.error(
      `      ${fillsOnAccounts - claims.length} fill(s) have no completed idempotency record — a retry with a fresh key would double them`,
    );
  }
  if (drifted > 0 || doubled.length > 0 || missing.length > 0 || fillsOnAccounts > claims.length) {
    throw new Error(`financial state did not survive: ${label}`);
  }
}

// ---- processes ---------------------------------------------------------------

const recent: string[] = [];

function spawnApi(port: string, ingest: boolean, env: Record<string, string>): ChildProcess {
  const child = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
      API_PORT: port,
      MARKET_INGEST_ENABLED: ingest ? 'true' : 'false',
      TRIGGER_ENGINE_ENABLED: ingest ? 'true' : 'false',
      PRICE_ALERTS_ENABLED: 'false',
      // Two instances, thirty-odd tenants left behind by other harnesses, and a
      // local Postgres allowing a hundred connections: the pool count and size
      // are held small so what is measured is the money, not the pool.
      DATABASE_TENANT_POOLS: '6',
      IDEMPOTENCY_TAKEOVER_AFTER_MS: String(TAKEOVER_MS),
      RATE_LIMIT_LOGIN_PER_MINUTE: '100000',
      RATE_LIMIT_ORDERS_PER_MINUTE: '100000',
      RATE_LIMIT_API_PER_MINUTE: '100000',
      ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE: '100000',
      ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE: '10000000',
      LOG_LEVEL: 'warn',
    },
  });
  // Kept, not discarded: an INTERNAL_ERROR from the API is only debuggable from here.
  child.stdout?.on('data', (chunk: Buffer) => recent.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => recent.push(chunk.toString()));
  return child;
}

async function waitForBoot(base: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      /**
       * With what the instance actually said.
       *
       * `recent` exists precisely so a failure here is debuggable — the comment
       * on it says so — and this path threw a one-line message and discarded
       * every byte of it. A harness that collects the diagnosis and prints
       * `did not become healthy` is worse than one that collects nothing,
       * because it looks like there is nothing to find.
       */
      const tail = recent.join('').trim().split('\n').slice(-25).join('\n');
      throw new Error(
        `${base} did not become healthy in 90s. What the instance said:\n\n${
          tail === '' ? '  (it printed nothing at all — check that apps/api/dist exists)' : tail
        }`,
      );
    }
    await sleep(500);
  }
}

/**
 * Waits until the serving instance is being told a price it would trust.
 *
 * ## Why this asks the probe and not the engine
 *
 * The first version of this placed a real order and waited for it to fill.
 * That is the most direct question available and it is the wrong one to ask
 * here: every fill on these accounts is compared against the harness's own
 * idempotency keys, so an order placed outside that bookkeeping reads as a fill
 * nobody can retry safely — an orphan. Four scenarios went from passing to
 * "financial state did not survive", and the harness was right: the probe had
 * created exactly the defect the invariant exists to detect.
 *
 * `/health/market` answers the same question with no side effect at all. It is
 * the number the engine itself refuses on, so this is not a proxy for
 * freshness; it is freshness.
 */
/**
 * Waits until the serving instance is quoting again, then lets the burst decide.
 *
 * ## Three attempts at this, and what each one taught
 *
 * The scenario originally slept 1.5 seconds and asserted that orders fill. They
 * did not: ten attempts, ten `STALE_QUOTE`, every one the engine correctly
 * refusing to fill at a price it no longer trusted. Severing every Postgres
 * connection cuts the *ingest* instance's too, and it needs longer than a
 * second and a half to resume publishing — so the scenario was failing the
 * platform for behaving exactly as §26 requires, under a message that named the
 * one thing which *had* come back.
 *
 * The second attempt waited by placing a real order and watching for a fill.
 * That is the most direct question available and the wrong one to ask from
 * here: every fill on these accounts is reconciled against the harness's own
 * idempotency keys, so an order placed outside that bookkeeping reads as a fill
 * nobody can retry safely. Four scenarios went from passing to "financial state
 * did not survive" — the invariant was right, and the probe had manufactured
 * the very defect it exists to catch. **A harness that writes to the system it
 * measures is measuring itself.**
 *
 * The third attempt polled `/health/market`, which reports `newestTickAgeMs`
 * per process. Both instances answered "no tick yet" throughout a window in
 * which orders were filling, so that gauge is not the quote the engine prices
 * against and this is not the place to find out what it is.
 *
 * So: the harness's own `waitForQuotes`, which is read-only, already proven
 * here, and asks the serving instance the question the scenario actually cares
 * about — are there quotes to trade on. Then the burst itself decides, and on a
 * failure it reports the codes rather than a conclusion.
 */
async function waitForQuotesBack(token: string, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const quotes = await call<Array<{ symbol: string }>>('/market/quotes', { token });
    if ((quotes.body?.data?.length ?? 0) > 0) {
      // Quoted, but the engine also wants the tick to be recent. One settle
      // period beyond the first quote is cheap and removes the race.
      await sleep(2_000);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the platform was not quoting again within ${String(withinMs / 1000)}s of the database ` +
          `coming back — which is the feed recovering, not the pool`,
      );
    }
    await sleep(500);
  }
}

async function waitForQuotes(token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const quotes = await call<Array<{ symbol: string }>>('/market/quotes', { token });
    if ((quotes.body?.data?.length ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('nothing is quoting');
    await sleep(500);
  }
}

function kill(
  child: ChildProcess | null,
  signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL',
): Promise<void> {
  return new Promise((resolve) => {
    if (child === null || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

// ---- scenarios ---------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  if (!databaseUrl || !redisUrl)
    throw new Error('DATABASE_URL and REDIS_URL are required (from .env)');
  const pgPort = Number(new URL(databaseUrl).port || '5432');
  const redisPort = Number(new URL(redisUrl).port || '6379');

  const pg = new Proxy('postgres', 15432, pgPort);
  const redis = new Proxy('redis', 16379, redisPort);
  await pg.start();
  await redis.start();

  const env: Record<string, string> = {
    DATABASE_URL: rewritePort(databaseUrl, 15432),
    REDIS_URL: rewritePort(redisUrl, 16379),
  };
  if (process.env['DATABASE_URL_TENANT'])
    env['DATABASE_URL_TENANT'] = rewritePort(process.env['DATABASE_URL_TENANT'], 15432);

  const prisma = new PrismaClient();
  /**
   * One at a time. Booting an instance reconciles roles for every tenant, and
   * each tenant it touches opens a pool that is only evicted after a grace
   * period; on a database that has seen thirty pentest tenants that is forty
   * connections per instance for a few seconds. Two at once, through a local
   * Postgres that allows a hundred, is how this harness first failed — at
   * registration, before anything had been injected.
   */
  let ingest: ChildProcess | null = spawnApi(INGEST_PORT, true, env);
  await waitForBoot(`http://127.0.0.1:${INGEST_PORT}`);
  await sleep(8_000);
  let api: ChildProcess | null = spawnApi(PORT, false, env);
  const passed: string[] = [];
  const failed: string[] = [];
  const scenario = async (name: string, run: () => Promise<void>) => {
    console.log(`\n  ▶ ${name}`);
    try {
      await run();
      passed.push(name);
      console.log(`  ✔ ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`  ✘ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    await waitForBoot(`http://127.0.0.1:${INGEST_PORT}`);
    await waitForBoot(BASE);
    console.log(
      `\n  ingest on :${INGEST_PORT}, serving on :${PORT}, both through proxies on :15432 (postgres) and :16379 (redis)`,
    );

    const traders = await Promise.all(Array.from({ length: 8 }, (_, i) => registerTrader(i)));
    await waitForQuotes(traders[0]!.token);
    const allKeys: string[] = [];
    const keys = (n: number) => {
      const fresh = Array.from({ length: n }, () => randomUUID());
      allKeys.push(...fresh);
      return fresh;
    };

    // A baseline, so every later number has something to be compared with.
    await scenario('baseline: a burst with nothing broken', async () => {
      const attempts = await burst(traders, keys(BURST));
      summarise('burst', attempts);
      assertCoded(attempts, false);
      await checkInvariant(prisma, traders, allKeys, 'baseline');
    });

    await scenario('the API is killed mid-burst and the same orders are retried', async () => {
      const retryKeys = keys(BURST);
      const inFlight = burst(traders, retryKeys);
      // Late enough that orders are committing when the process dies — the
      // window between an order's commit and its idempotency record is the one
      // a crash has to be shown not to open.
      await sleep(KILL_AFTER_MS);
      await kill(api);
      const first = await inFlight;
      summarise('during the kill', first);
      assertCoded(first, true);

      api = spawnApi(PORT, false, env);
      await waitForBoot(BASE);
      const second = await burst(traders, retryKeys);
      summarise('retried with the same keys', second);
      assertCoded(second, false);
      /**
       * Two kinds of refusal, both right. A claim the transaction marked
       * COMMITTED is refused as "applied, read the account". A claim the crash
       * left IN_PROGRESS with nothing committed is refused as "in flight" until
       * the takeover window passes — set short for this run — after which a
       * retry takes it over and the order fills, once.
       */
      await sleep(TAKEOVER_MS + 1_000);
      const third = await burst(traders, retryKeys);
      summarise('retried again after the takeover window', third);
      assertCoded(third, false);
      const stillInFlight = third.filter((a) => a.code === 'IDEMPOTENCY_KEY_CONFLICT').length;
      if (stillInFlight > 0)
        throw new Error(`${stillInFlight} claim(s) were still in flight after the takeover window`);
      await checkInvariant(prisma, traders, allKeys, 'API kill + retry');
    });

    await scenario('the API is asked to stop (SIGTERM) mid-burst', async () => {
      /**
       * A deploy, not a crash. The orchestrator sends SIGTERM and waits; the
       * process is meant to finish what it is doing and leave. What is pinned:
       * it leaves within the grace an orchestrator gives (30 s in the runbook),
       * nothing in flight is left half-applied, and the fills it did make have
       * their idempotency records — a graceful stop that loses the record is
       * the crash scenario with better manners.
       */
      const stopKeys = keys(BURST);
      const inFlight = burst(traders, stopKeys);
      await sleep(300);
      const askedAt = Date.now();
      await kill(api, 'SIGTERM');
      const exitMs = Date.now() - askedAt;
      const during = await inFlight;
      summarise('while stopping', during);
      console.log(`    exited ${exitMs} ms after SIGTERM`);
      if (exitMs > 30_000)
        throw new Error(`the API took ${exitMs} ms to stop; the runbook promises 30 s`);
      assertCoded(during, true);

      api = spawnApi(PORT, false, env);
      await waitForBoot(BASE);
      const after = await burst(traders, stopKeys);
      summarise('retried with the same keys', after);
      assertCoded(after, false);
      await checkInvariant(prisma, traders, allKeys, 'graceful stop');
    });

    await scenario('every database connection is severed mid-burst', async () => {
      const inFlight = burst(traders, keys(BURST));
      await sleep(80);
      const cut = pg.sever();
      console.log(`    severed ${cut} postgres connection(s)`);
      const attempts = await inFlight;
      summarise('severed', attempts);
      assertCoded(attempts, false);

      /**
       * Two things were severed, and they come back at different speeds.
       *
       * This waited 1.5 seconds and then asserted that orders fill again. They
       * did not: ten attempts, ten `STALE_QUOTE`, every one of them the engine
       * correctly refusing to fill at a price it no longer trusts. The database
       * pool had reconnected fine — what had not come back was the **feed**,
       * because severing every Postgres connection cuts the ingest instance's
       * too, and it needs longer than a second and a half to resume publishing.
       *
       * So the scenario was failing the platform for behaving exactly as §26
       * requires, and the failure message said "nothing fills after the
       * database came back" — which named the one thing that *had* come back.
       *
       * Now the feed is waited for explicitly, on its own bound and with its
       * own message, and only then is the pool asked to prove itself. A
       * harness that cannot say which of two recoveries it is measuring is
       * measuring neither.
       */
      await waitForQuotesBack(traders[0]!.token, 45_000);
      const after = await burst(traders, keys(10));
      summarise('afterwards', after);
      if (after.filter((a) => a.ok).length === 0) {
        const codes = after.map((a) => a.code ?? '(no code)').join(', ');
        throw new Error(
          `nothing fills after the database came back, and the feed was fresh: ${codes}`,
        );
      }
      await checkInvariant(prisma, traders, allKeys, 'severed database');
    });

    await scenario('the database answers 150 ms late', async () => {
      /**
       * A few orders, not a burst: the pool here is two connections, and
       * twelve orders queuing on it behind 150 ms round trips measures the
       * pool, not the platform. What this asks is whether a slow database
       * produces slow orders or wrong ones.
       */
      pg.latencyMs = 150;
      const before = pg.messages;
      const attempts = await burst(traders.slice(0, 4), keys(4));
      pg.latencyMs = 0;
      summarise('slow database', attempts);
      console.log(
        `    ≈${Math.round((pg.messages - before) / attempts.length)} database messages per order ` +
          `(everything the serving instance sent while the four were in flight, divided by four)`,
      );
      assertCoded(attempts, false);
      /**
       * Either outcome is right; a wrong one is a fill at a price the platform
       * no longer trusted. The ingest instance shares the slow database, its
       * tick pipeline falls behind, and the serving instance's quotes age past
       * `QUOTE_MAX_AGE_MS` — so a slow database can take the platform out of
       * pricing altogether. That is availability lost safely, and it is
       * reported here so somebody can decide whether ingest should wait on the
       * database at all.
       */
      const unsafe = attempts.filter((a) => !a.ok && !SAFE_REFUSALS.has(a.code ?? ''));
      if (unsafe.length > 0) {
        throw new Error(`${unsafe.length} order(s) refused unsafely on a slow database`);
      }
      await checkInvariant(prisma, traders, allKeys, 'slow database');
    });

    await scenario('Redis is unreachable for eight seconds', async () => {
      redis.refuse = true;
      redis.sever();
      const during = await burst(traders, keys(10));
      summarise('Redis away', during);
      assertCoded(during, false);
      await sleep(8_000);
      redis.refuse = false;
      await sleep(3_000);
      const after = await burst(traders, keys(10));
      summarise('Redis back', after);
      if (after.filter((a) => a.ok).length === 0)
        throw new Error('nothing fills after Redis came back');
      await checkInvariant(prisma, traders, allKeys, 'Redis away');
    });

    await scenario('the market data leader dies: a stale quote must never fill', async () => {
      await kill(ingest);
      // Past the lease and past the quote's maximum age.
      await sleep(16_000);
      const stale = await burst(traders, keys(6));
      summarise('no feed', stale);
      const filled = stale.filter((a) => a.ok);
      if (filled.length > 0)
        throw new Error(`${filled.length} order(s) filled on a feed that had stopped`);
      for (const attempt of stale) {
        if (!SAFE_REFUSALS.has(attempt.code ?? '')) {
          throw new Error(
            `refused with ${attempt.code ?? attempt.status}, which is not a stale-quote refusal`,
          );
        }
      }
      ingest = spawnApi(INGEST_PORT, true, env);
      await waitForBoot(`http://127.0.0.1:${INGEST_PORT}`);
      await waitForQuotes(traders[0]!.token);
      await sleep(2_000);
      const after = await burst(traders, keys(6));
      summarise('feed restored', after);
      if (after.filter((a) => a.ok).length === 0)
        throw new Error('nothing fills after the feed came back');
      await checkInvariant(prisma, traders, allKeys, 'market data gap');
    });

    console.log(`\n  ${passed.length} scenario(s) held the invariant, ${failed.length} did not.`);
    if (failed.length > 0) {
      console.error(`  Failed: ${failed.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    await kill(api);
    await kill(ingest);
    await prisma.$disconnect();
    await pg.stop();
    await redis.stop();
  }
}

main().catch((error) => {
  console.error(error);
  const tail = recent
    .join('')
    .split('\n')
    .filter((line) => /error|ERROR|level":50/.test(line))
    .slice(-12);
  if (tail.length > 0) console.error('\n  Last errors from the API processes:\n' + tail.join('\n'));
  process.exit(1);
});
