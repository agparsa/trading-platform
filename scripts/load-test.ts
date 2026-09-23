/**
 * Load harness.
 *
 * Answers three questions the unit suite cannot, because they are all about what
 * happens when the platform is busier than it is comfortable with:
 *
 *   1. Do sequence numbers stay gapless when many sockets are served at once?
 *      A gap is not a performance problem, it is a correctness one — the client
 *      contract says a gap means re-snapshot, and a platform that manufactures
 *      gaps under load makes that contract worthless.
 *   2. What does an order actually cost, end to end, while that is happening?
 *   3. Does the trigger engine fall behind the feed, and if so, is it coalescing
 *      rather than losing ticks?
 *
 * It reports numbers and fails only on correctness: gaps, errors, rejected
 * orders. Latency is printed, not asserted — a threshold that passes on this
 * machine and fails on a busy CI runner teaches nobody anything.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';

const PORT = process.env['API_PORT'] ?? '4000';
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * A second instance, which does nothing but ingest.
 *
 * The first run of this harness at a hundred traders found something real: one
 * process serving two hundred sockets and a thousand orders starves its own
 * market feed. Only 149 ticks arrived in a minute, quotes aged past
 * `QUOTE_MAX_AGE_MS`, and the engine — correctly — refused to trade on them.
 *
 * The platform was right. The *deployment* was wrong, and it was the deployment
 * this harness had invented: production separates ingest from serving, which is
 * exactly what `MARKET_INGEST_ENABLED` and the `market:ticks` relay exist for.
 * So the harness now boots the pair, and in doing so measures the relay under
 * load as well.
 */
const INGEST_PORT = process.env['LOAD_INGEST_PORT'] ?? '4111';
const PASSWORD = 'a-sufficiently-long-passphrase';

const TRADERS = Number(process.env['LOAD_TRADERS'] ?? 100);
const SOCKETS_PER_TRADER = Number(process.env['LOAD_SOCKETS_PER_TRADER'] ?? 2);
const ORDERS_PER_TRADER = Number(process.env['LOAD_ORDERS_PER_TRADER'] ?? 10);
const OBSERVE_MS = Number(process.env['LOAD_OBSERVE_MS'] ?? 20_000);

/**
 * How long the steady phase runs, and how many orders it spreads over that.
 *
 * A steady phase is not a slower burst. It is the shape of ordinary trading —
 * requests arriving continuously rather than all at once — and it answers a
 * question the burst cannot: what does the platform *feel like* while it is
 * being used, as opposed to while it is being hit.
 */
const STEADY_MS = Number(process.env['LOAD_STEADY_MS'] ?? 15_000);
/** Traders registered concurrently while the run is being set up. */
const REGISTRATION_BATCH = Number(process.env['LOAD_REGISTRATION_BATCH'] ?? 100);
const STEADY_ORDERS_PER_TRADER = Number(process.env['LOAD_STEADY_ORDERS'] ?? 3);

interface Frame {
  event: string;
  seq: number;
  timestamp: number;
}

/**
 * Refusals that mean the platform declined to price an order, rather than that
 * something went wrong.
 *
 * A stale quote under a burst is the engine refusing to fill at a price it no
 * longer trusts. That is the behaviour §26 asks for — an infrastructure problem
 * must never become a trade — and it is a capacity limit, not a defect.
 */
const SAFE_REFUSALS = new Set([
  'STALE_QUOTE',
  'NO_QUOTE_AVAILABLE',
  'TRADING_HALTED',
  /**
   * The instance refusing at its concurrency limit (`HTTP_MAX_IN_FLIGHT`).
   * A coded 503 with Retry-After is the platform saying "not now" to an order
   * it never began — the safe answer, and the one that replaced a hundred and
   * twenty connection resets at two thousand simultaneous orders.
   */
  'SERVICE_UNAVAILABLE',
]);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

async function json<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok: boolean; data: T; error?: { message: string } };
  if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload.data;
}

interface Trader {
  token: string;
  accountId: string;
}

async function registerTrader(index: number): Promise<Trader> {
  const email = `load-${Date.now()}-${index}@test.local`;
  const registered = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Load ${index}` }),
  });
  /**
   * Checked, because the next line depends on it.
   *
   * This response used to be discarded. When registration was refused — rate
   * limited, or failing under the very load this harness applies — the login
   * below answered `Invalid email or password`, and that is what the run
   * reported: a message about credentials, for a failure that had nothing to do
   * with them, with the actual status code already thrown away.
   */
  if (registered.status !== 201 && registered.status !== 202) {
    const body = (await registered.text()).slice(0, 200);
    throw new Error(`trader ${index} could not register: HTTP ${registered.status} ${body}`);
  }
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!login.ok) {
    const body = (await login.text()).slice(0, 200);
    throw new Error(
      `trader ${index} registered (HTTP ${registered.status}) and then could not sign in: ` +
        `HTTP ${login.status} ${body}`,
    );
  }
  const { accessToken } = await json<{ accessToken: string }>(login);
  const accounts = await json<Array<{ id: string }>>(
    await fetch(`${BASE}/api/v1/accounts`, { headers: { Authorization: `Bearer ${accessToken}` } }),
  );
  const accountId = accounts[0]?.id;
  assert(accountId !== undefined, 'registration opened no account');
  return { token: accessToken, accountId: accountId! };
}

/**
 * Waits for one instance, and says what it was saying if it never arrives.
 *
 * `said` is the buffer belonging to *that* instance. Passing the wrong one is
 * how a harness ends up telling somebody to read a file about a process that
 * was fine.
 */
async function waitForBoot(base: string = BASE, said: readonly string[] = []): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      const tail = said.join('').trim().split('\n').slice(-25).join('\n');
      throw new Error(
        `${base} did not become healthy in 60s. What that instance said:\n\n${
          tail === ''
            ? '  (nothing at all — check that apps/api/dist exists and the port is free)'
            : tail
        }`,
      );
    }
    await sleep(500);
  }
}

async function assertPortFree(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  throw new Error(
    `Something is already listening on ${BASE}. Stop it first — otherwise this would measure it instead of the build under test.`,
  );
}

/**
 * How old the newest tick is, as the platform itself reports it.
 *
 * From `/health/market` rather than counted here, so the harness asserts the
 * same number an operator's alerting would see. `null` means no tick has ever
 * arrived, which on this instance would mean the relay never delivered one.
 */
async function newestTickAge(): Promise<number | null> {
  try {
    const response = await fetch(`${BASE}/health/market`);
    /**
     * Unwrapped twice: the API wraps every response in `{ok, data, meta}`, and
     * Terminus's own payload is what sits inside `data`.
     */
    const envelope = (await response.json()) as {
      data?: {
        details?: Record<string, { newestTickAgeMs?: number | null }>;
        info?: Record<string, { newestTickAgeMs?: number | null }>;
      };
    };
    const detail = envelope.data?.details?.['market-data'] ?? envelope.data?.info?.['market-data'];
    return detail?.newestTickAgeMs ?? null;
  } catch {
    return null;
  }
}

/**
 * A gauge's current value, summed over its labels.
 *
 * Read from the ingest instance, which is the one whose per-tick cost the open
 * position count actually describes.
 */
async function gaugeValue(name: string): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${INGEST_PORT}/metrics`)).text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

async function counterValue(name: string): Promise<number> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

async function main(): Promise<void> {
  await assertPortFree();
  /**
   * The rate limits are raised for this run, deliberately.
   *
   * They are per-IP, and the whole harness comes from one address, so at their
   * production settings this would measure the throttler rather than the engine.
   * The throttler is a security control with its own coverage — the smoke suite
   * asserts that a trading route needs a token, and the login limiter is
   * exercised by the auth tests. What is being measured here is what the engine
   * does when the requests actually reach it.
   */
  const limits = {
    RATE_LIMIT_LOGIN_PER_MINUTE: '100000',
    RATE_LIMIT_ORDERS_PER_MINUTE: '100000',
    RATE_LIMIT_API_PER_MINUTE: '100000',
    // The socket limit too: a hundred terminals each sending five subscribes
    // on connect is ordinary traffic, and this run is not about that limit.
    RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE: '100000',
    /**
     * The connection budget, stated for this run.
     *
     * Every trader here lives in one tenant, so the run needs a handful of
     * pools, not the default thirty-two. Left at the default against a
     * development database that the penetration suite has filled with tenants,
     * the two instances asked a stock Postgres for 340 connections out of 100 —
     * role reconciliation failed for some tenants and the first registration
     * came back `INTERNAL_ERROR`. That was a real finding (the API now reports
     * its budget at boot), but it is not the one this harness measures.
     */
    DATABASE_TENANT_POOLS: process.env['LOAD_TENANT_POOLS'] ?? '1',
  };

  /**
   * The pool, sized for the concurrency this run drives.
   *
   * Prisma's default is `cpus × 2 + 1` — five on the two-core box that measured
   * everything in `docs/capacity.md`. Five hundred traders placing orders at
   * once queue on five connections, the queue outlives the pool's ten-second
   * wait, and the run measures `P2024` instead of the engine. The runbook says
   * to raise the pool with concurrency, not with core count; this is that
   * advice, applied to the run. The ingest instance serves nobody and keeps a
   * small one, so that between them the pair stays inside a stock Postgres's
   * hundred connections: serving (1 tenant + 1 unscoped) × 25 + 25 privileged
   * = 75, ingest (1 + 1) × 5 + 5 = 15.
   */
  const servingLimit = process.env['LOAD_CONNECTION_LIMIT'] ?? '25';
  const withConnectionLimit = (url: string | undefined, limit: string): string | undefined => {
    if (url === undefined) return undefined;
    const parsed = new URL(url);
    parsed.searchParams.set('connection_limit', limit);
    return parsed.toString();
  };
  const pooled = (limit: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const owner = withConnectionLimit(process.env['DATABASE_URL'], limit);
    const tenant = withConnectionLimit(process.env['DATABASE_URL_TENANT'], limit);
    if (owner !== undefined) out['DATABASE_URL'] = owner;
    if (tenant !== undefined) out['DATABASE_URL_TENANT'] = tenant;
    return out;
  };

  /**
   * The ingest instance: it produces prices and fires stops, and serves nobody.
   *
   * This is how production is deployed, and it is not an optimisation. Exactly
   * one process may pull from the provider or candle volume is counted twice,
   * and a process doing that while serving two hundred sockets starves its own
   * feed — which this harness demonstrated the first time it was run at a
   * hundred traders.
   */
  const ingest = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...limits,
      ...pooled('5'),
      API_PORT: INGEST_PORT,
      MARKET_INGEST_ENABLED: 'true',
      TRIGGER_ENGINE_ENABLED: 'true',
    },
  });
  /**
   * Kept, not discarded.
   *
   * These two lines used to be `() => undefined`, which is a deliberate choice
   * to throw away everything the ingest instance says — and the ingest instance
   * is the first thing this harness waits for. When it failed to boot the run
   * printed `did not become healthy` and pointed at *the serving instance's*
   * log, which for a failure this early had not been written at all. The one
   * process that could explain the failure was the one being silenced.
   */
  const ingestOutput: string[] = [];
  ingest.stdout.on('data', (chunk: Buffer) => ingestOutput.push(chunk.toString()));
  ingest.stderr.on('data', (chunk: Buffer) => ingestOutput.push(chunk.toString()));

  /**
   * The instance under test: it serves, and relays prices from the other one
   * over `market:ticks`.
   */
  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...limits,
      ...pooled(servingLimit),
      API_PORT: PORT,
      MARKET_INGEST_ENABLED: 'false',
      TRIGGER_ENGINE_ENABLED: 'false',
    },
  });
  const output: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const sockets: Socket[] = [];
  let failed = false;
  /**
   * What each phase saw, kept outside the `try` so a run that dies half-way
   * still says what it had measured. A histogram of refusal codes is the
   * difference between "fetch failed" and knowing the queue was already
   * refusing `CONCURRENT_MODIFICATION` for a full round before the socket went.
   */
  const progress: string[] = [];
  const histogram = (codes: readonly string[]): string => {
    const counts = new Map<string, number>();
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code}×${count}`)
      .join(', ');
  };

  try {
    await waitForBoot(`http://127.0.0.1:${INGEST_PORT}`, ingestOutput);
    await waitForBoot(BASE, output);
    console.log(
      `\n  one ingest instance on :${INGEST_PORT}, one serving instance on :${PORT},` +
        `\n  prices relayed between them over market:ticks — as production runs.\n`,
    );
    console.log(
      `  ${TRADERS} traders · ${TRADERS * SOCKETS_PER_TRADER} sockets · ` +
        `${TRADERS * ORDERS_PER_TRADER} orders · ${OBSERVE_MS / 1000}s observation` +
        `\n  (per-IP rate limits raised for this run — see the note in the script)\n`,
    );

    /**
     * Registered in batches, not all at once. A thousand simultaneous
     * registrations are not what a thousand traders look like — they arrive
     * over months — and above `HTTP_MAX_IN_FLIGHT` the API would rightly
     * refuse the excess. The traders exist before the measurement starts;
     * how fast they were created is not what this harness measures.
     */
    const traders: Trader[] = [];
    for (let start = 0; start < TRADERS; start += REGISTRATION_BATCH) {
      const batch = Array.from(
        { length: Math.min(REGISTRATION_BATCH, TRADERS - start) },
        (_, offset) => registerTrader(start + offset),
      );
      traders.push(...(await Promise.all(batch)));
    }

    /**
     * What the platform is already holding.
     *
     * Printed because it changes the answer. The ingest process checks every
     * open position against every tick — that is what a stop-loss *is* — so the
     * per-tick cost scales with the whole platform's open interest, not with
     * this run's. A figure of "180 orders/s" means nothing without saying what
     * the book looked like while it was measured.
     *
     * Read from `/metrics`, which is public and needs no operator token.
     */
    const openPositionsBefore = await gaugeValue('tp_open_positions');
    const accountsBefore = await gaugeValue('tp_accounts');

    const symbols = await json<Array<{ symbol: string }>>(
      await fetch(`${BASE}/api/v1/market/quotes`, {
        headers: { Authorization: `Bearer ${traders[0]!.token}` },
      }),
    );
    assert(symbols.length > 0, 'nothing is quoting');

    // --- sockets ------------------------------------------------------------
    /**
     * Per socket: how many frames, whether the sequence ever skipped, what
     * errored. Counts, not the frames themselves — five thousand sockets
     * retaining every frame for a minute is gigabytes in the generator, and
     * at that point the harness is measuring its own memory.
     */
    const streams: Array<{ frames: number; gapped: boolean; errors: string[] }> = [];
    for (const trader of traders) {
      for (let i = 0; i < SOCKETS_PER_TRADER; i += 1) {
        const stream = { frames: 0, gapped: false, errors: [] as string[] };
        const socket = io(BASE, {
          path: '/ws',
          transports: ['websocket'],
          auth: { token: trader.token },
        });
        socket.on('frame', (frame: Frame) => {
          stream.frames += 1;
          if (frame.seq !== stream.frames) stream.gapped = true;
        });
        socket.on('connect_error', (error: Error) => stream.errors.push(error.message));
        socket.on('connect', () => {
          for (const channel of ['quotes', 'positions', 'account', 'pnl']) {
            socket.emit('subscribe', { channel });
          }
        });
        sockets.push(socket);
        streams.push(stream);
      }
    }
    await sleep(3_000);
    const socketsOpenedAt = Date.now();

    const coalescedBefore = await counterValue('tp_ticks_coalesced_total');

    // --- orders, while the sockets are being served -------------------------
    const latencies: number[] = [];
    const rejections: string[] = [];
    /**
     * A request the transport lost is a refusal too, and the worst kind: the
     * client does not know whether the order was placed. It is recorded as
     * `TRANSPORT:<cause>` so it fails the safe-refusal check by name rather than
     * aborting the run and taking every other number with it.
     */
    let inFlight = 0;
    let peakInFlight = 0;
    const submit = async (trader: Trader, index: number): Promise<void> => {
      const symbol = symbols[index % symbols.length]!.symbol;
      const startedAt = Date.now();
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const response = await fetch(`${BASE}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${trader.token}`,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            accountId: trader.accountId,
            symbol,
            side: index % 2 === 0 ? 'BUY' : 'SELL',
            volume: '0.01',
          }),
        });
        latencies.push(Date.now() - startedAt);
        const payload = (await response.json()) as { ok: boolean; error?: { code: string } };
        if (!payload.ok) rejections.push(payload.error?.code ?? 'UNKNOWN');
      } catch (error) {
        latencies.push(Date.now() - startedAt);
        const cause = (error as { cause?: { code?: string } }).cause;
        rejections.push(
          `TRANSPORT:${cause?.code ?? (error as Error).message} after ${Date.now() - startedAt} ms with ${inFlight} in flight`,
        );
      } finally {
        inFlight -= 1;
      }
    };

    /**
     * One order, on its own, before the burst.
     *
     * This is the number a trader actually experiences, and it is not the number
     * the burst produces. Firing 120 orders simultaneously and reporting the
     * spread of their round trips measures how long the *queue* took to drain,
     * not how long an order takes to serve — and a reader who sees "p50 2005ms"
     * will reasonably conclude that placing an order takes two seconds, which is
     * false by a factor of forty.
     *
     * A metric that misleads is worse than no metric. So both are reported, and
     * each is labelled as what it is.
     */
    const quiet: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const startedAt = Date.now();
      await submit(traders[0]!, 100 + i);
      quiet.push(Date.now() - startedAt);
    }
    latencies.length = 0;
    rejections.length = 0;

    /**
     * Three phases, and each answers something the others cannot.
     *
     * **Steady** is what ordinary use looks like: requests arriving continuously
     * rather than all at once. It is the number a trader lives with.
     *
     * **Burst** is everything at the same instant. It measures how long a queue
     * takes to drain, which is a different quantity from how long an order takes
     * to serve, and is reported as such.
     *
     * **Recovery** is the one usually left out, and it is the one that catches
     * the interesting failures. A platform that serves a burst and then stays
     * degraded — connection pool exhausted, a lock never released, memory that
     * never comes back — passes a burst test and fails in production an hour
     * later. So the unloaded measurement is taken again, afterwards, and
     * compared with the one from before.
     */

    // --- phase 1: steady ----------------------------------------------------
    const steady: number[] = [];
    const steadyStartedAt = Date.now();
    const gapMs = Math.max(1, Math.floor(STEADY_MS / Math.max(1, STEADY_ORDERS_PER_TRADER)));
    for (let round = 0; round < STEADY_ORDERS_PER_TRADER; round += 1) {
      const roundStartedAt = Date.now();
      const before = latencies.length;
      await Promise.all(traders.map((trader, index) => submit(trader, round * 7 + index)));
      for (const value of latencies.slice(before)) steady.push(value);
      const remaining = gapMs - (Date.now() - roundStartedAt);
      if (remaining > 0) await sleep(remaining);
    }
    const steadyElapsed = Date.now() - steadyStartedAt;
    const steadyOrders = TRADERS * STEADY_ORDERS_PER_TRADER;
    const steadyRejections = [...rejections];
    progress.push(
      `steady: ${steadyOrders} orders in ${steadyElapsed} ms, p50 ${percentile(steady, 50)} ms, ` +
        `p95 ${percentile(steady, 95)} ms; refused ${steadyRejections.length}` +
        (steadyRejections.length > 0 ? ` (${histogram(steadyRejections)})` : ''),
    );
    latencies.length = 0;
    rejections.length = 0;

    // --- phase 2: burst -----------------------------------------------------
    const orderStartedAt = Date.now();
    await Promise.all(
      traders.flatMap((trader) =>
        Array.from({ length: ORDERS_PER_TRADER }, (_, index) => submit(trader, index)),
      ),
    );
    const orderElapsed = Date.now() - orderStartedAt;
    const burst = [...latencies];
    const burstRejections = [...rejections];
    progress.push(
      `burst: ${burst.length} orders in ${orderElapsed} ms, p50 ${percentile(burst, 50)} ms; ` +
        `refused ${burstRejections.length}` +
        (burstRejections.length > 0 ? ` (${histogram(burstRejections)})` : ''),
    );
    rejections.length = 0;

    // --- phase 3: recovery --------------------------------------------------
    // A short pause, then the same single-order measurement taken before the
    // load started. If this is much worse than `quiet`, the platform did not
    // come back — and that is a fault a burst test alone would have passed.
    await sleep(3_000);
    const recovered: number[] = [];
    const feedAgeAfterBurst = await newestTickAge();
    for (let i = 0; i < 5; i += 1) {
      const startedAt = Date.now();
      await submit(traders[0]!, 200 + i);
      recovered.push(Date.now() - startedAt);
    }

    // --- watch the stream under that load -----------------------------------
    await sleep(OBSERVE_MS);
    const coalescedAfter = await counterValue('tp_ticks_coalesced_total');
    const ticks = await counterValue('tp_market_ticks_total');
    const feedAgeMs = await newestTickAge();

    // --- results ------------------------------------------------------------
    const allFrames = streams.reduce((total, stream) => total + stream.frames, 0);
    const socketErrors = streams.flatMap((stream) => stream.errors);

    let gaps = 0;
    let emptyStreams = 0;
    for (const stream of streams) {
      if (stream.frames === 0) emptyStreams += 1;
      if (stream.gapped) gaps += 1;
    }

    const orders = TRADERS * ORDERS_PER_TRADER;
    const rows: Array<[string, string]> = [
      ['Traders registered for this run', String(TRADERS)],
      ['Accounts on the platform beforehand', String(accountsBefore)],
      ['Open positions on the platform beforehand', String(openPositionsBefore)],
      ['Sockets held open', String(sockets.length)],
      ['Frames delivered', String(allFrames)],
      [
        // Over the time the sockets were actually open, not the observation
        // window: a twenty-minute run at a thousand traders once reported 92
        // frames a second by dividing a run's worth of frames by twenty seconds.
        'Frames per socket per second',
        (allFrames / sockets.length / ((Date.now() - socketsOpenedAt) / 1000)).toFixed(1),
      ],
      ['Sockets with a sequence gap', String(gaps)],
      ['Sockets that received nothing', String(emptyStreams)],
      ['Socket errors', String(socketErrors.length)],
      ['Peak orders in flight', String(peakInFlight)],
      ['Orders submitted', String(orders + steadyOrders + quiet.length + recovered.length)],
      [
        'Orders rejected',
        String(steadyRejections.length + burstRejections.length + rejections.length),
      ],
      ['— phase 1, steady —', ''],
      ['Steady orders', String(steadyOrders)],
      ['Steady throughput (per second)', (steadyOrders / (steadyElapsed / 1000)).toFixed(1)],
      ['Steady round trip p50 (ms)', String(percentile(steady, 50))],
      ['Steady round trip p95 (ms)', String(percentile(steady, 95))],
      ['Steady round trip max (ms)', String(Math.max(...steady, 0))],
      [
        'Steady rejections',
        steadyRejections.length === 0
          ? '0'
          : `${steadyRejections.length} (${[...new Set(steadyRejections)].join(', ')})`,
      ],
      ['— phase 2, burst —', ''],
      ['Burst orders', String(orders)],
      ['Order throughput (per second)', (orders / (orderElapsed / 1000)).toFixed(1)],
      ['Round trip under burst p50 (ms)', String(percentile(burst, 50))],
      ['Round trip under burst p95 (ms)', String(percentile(burst, 95))],
      ['Round trip under burst p99 (ms)', String(percentile(burst, 99))],
      ['Round trip under burst max (ms)', String(Math.max(...burst, 0))],
      [
        'Burst rejections',
        burstRejections.length === 0
          ? '0'
          : `${burstRejections.length} (${[...new Set(burstRejections)].join(', ')})`,
      ],
      [
        'Newest tick age right after the burst (ms)',
        feedAgeAfterBurst === null ? 'never' : String(feedAgeAfterBurst),
      ],
      ['— phase 3, recovery —', ''],
      ['Service time, unloaded p50 (ms)', String(percentile(quiet, 50))],
      ['Service time, unloaded max (ms)', String(Math.max(...quiet))],
      ['Service time after the burst p50 (ms)', String(percentile(recovered, 50))],
      ['Service time after the burst max (ms)', String(Math.max(...recovered))],
      ['Market ticks seen by the serving instance', String(ticks)],
      ['Newest tick age at the end (ms)', feedAgeMs === null ? 'never' : String(feedAgeMs)],
      ['Ticks coalesced into a running pass', String(coalescedAfter - coalescedBefore)],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    console.log(rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n'));

    console.log('\n  Correctness under load:');
    const checks: Array<[string, boolean, string]> = [
      ['sequence numbers stayed gapless', gaps === 0, `${gaps} socket(s) saw a gap`],
      ['every socket received frames', emptyStreams === 0, `${emptyStreams} socket(s) got nothing`],
      ['no socket errored', socketErrors.length === 0, socketErrors.slice(0, 3).join('; ')],
      /**
       * The platform may refuse. It may not refuse *wrongly*.
       *
       * `STALE_QUOTE` and `NO_QUOTE_AVAILABLE` are safe refusals: the engine has
       * decided it cannot price the order against a quote it trusts, and has
       * said so. That is the answer §26 demands — an infrastructure problem must
       * never become a trade — and under enough load it is the *correct* answer,
       * because a price the process has not caught up with is genuinely old.
       *
       * Anything else — an internal error, a conflicted idempotency key, a
       * validation failure, a margin decision that should not have been made —
       * would mean the load had found a bug rather than a limit.
       *
       * This is the assertion that matters, and it is deliberately not "nothing
       * was rejected". A platform that fills every order under any load is a
       * platform that is filling some of them at prices it should not trust.
       */
      [
        'every refusal was a safe one',
        [...steadyRejections, ...burstRejections, ...rejections].every((code) =>
          SAFE_REFUSALS.has(code),
        ),
        `unsafe: ${[
          ...new Set(
            [...steadyRejections, ...burstRejections, ...rejections].filter(
              (code) => !SAFE_REFUSALS.has(code),
            ),
          ),
        ].join(', ')}`,
      ],
      /**
       * Did the feed keep up while all that was happening?
       *
       * This is the check the first hundred-trader run failed, and it failed for
       * a reason worth keeping a test for: a process that both ingests and
       * serves starves its own market data, quotes age past
       * `QUOTE_MAX_AGE_MS`, and the engine refuses to trade on them. The engine
       * was right to refuse. The deployment was wrong.
       *
       * Reading it from `/health/market` rather than counting ticks makes it the
       * platform's own answer, in the same terms an operator's alerting sees.
       */
      [
        'the market feed kept up',
        feedAgeMs !== null && feedAgeMs < 10_000,
        `the newest tick was ${feedAgeMs === null ? 'never' : `${feedAgeMs}ms`} old at the end`,
      ],
      /**
       * The recovery check, and the only latency assertion in this file.
       *
       * Latency is otherwise printed rather than asserted, because a threshold
       * that passes here and fails on a busy CI runner teaches nobody anything.
       * This one is different: it compares the platform against *itself*, before
       * and after the burst, on the same machine and in the same run. A tenfold
       * degradation that persists is a leak, an exhausted pool or a lock never
       * released — not a slow runner.
       *
       * The floor of 50ms stops the ratio being meaningless when both numbers
       * are tiny: 2ms becoming 20ms is noise, not a regression.
       */
      [
        'the platform came back after the burst',
        percentile(recovered, 50) <= Math.max(50, percentile(quiet, 50) * 10),
        `unloaded p50 was ${percentile(quiet, 50)}ms before and ${percentile(recovered, 50)}ms after`,
      ],
    ];
    for (const [name, ok, detail] of checks) {
      if (ok) console.log(`    ok  ${name}`);
      else {
        failed = true;
        console.error(`    FAIL ${name}: ${detail}`);
      }
    }

    // Coalescing is reported, never asserted. Zero means the engine kept up,
    // which is a fine outcome; a large number means it did not, and the point is
    // that no tick was lost either way.
    console.log(
      coalescedAfter > coalescedBefore
        ? `\n  The engine ran behind the feed and coalesced ${coalescedAfter - coalescedBefore} tick(s). None were dropped.`
        : '\n  The engine kept up with the feed; nothing needed coalescing.',
    );

    /**
     * Say plainly what the two latency figures mean, because the difference
     * between them is the difference between "orders are slow" and "this box
     * served every order it was handed at once".
     */
    console.log(
      `\n  An order placed on its own is served in ~${percentile(quiet, 50)}ms.\n` +
        `  The burst figures above are queue depth: ${orders} orders fired simultaneously at\n` +
        `  ${(orders / (orderElapsed / 1000)).toFixed(0)}/s take ${(orderElapsed / 1000).toFixed(1)}s to drain, and each one's round trip includes\n` +
        `  the wait. They are a capacity measurement, not a latency a trader would see.`,
    );
  } catch (error) {
    failed = true;
    console.error(`\n  ${(error as Error).message}`);
    // `fetch failed` on its own names nothing; undici puts the reason underneath.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (cause !== undefined) console.error(`  cause: ${cause.code ?? ''} ${cause.message ?? ''}`);
    for (const line of progress) console.error(`  before that — ${line}`);
    console.error(output.join('').slice(-3000));
  } finally {
    for (const socket of sockets) socket.close();
    api.kill('SIGTERM');
    ingest.kill('SIGTERM');
    if (failed) {
      // The tail above is rarely where the cause is. Keep everything the
      // instance said, so a failure at a thousand traders can be read rather
      // than guessed.
      const dump = join(tmpdir(), `load-test-api-${process.pid}.log`);
      writeFileSync(dump, output.join(''));
      const ingestDump = join(tmpdir(), `load-test-ingest-${process.pid}.log`);
      writeFileSync(ingestDump, ingestOutput.join(''));
      console.error(`\n  the serving instance's full output is in ${dump}`);
      console.error(`  the ingest instance's full output is in ${ingestDump}`);
    }
  }

  if (failed) {
    console.error('\nLoad test failed.\n');
    process.exit(1);
  }
  console.log('\nLoad test passed.\n');
  process.exit(0);
}

void main();
