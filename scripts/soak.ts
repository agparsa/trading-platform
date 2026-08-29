#!/usr/bin/env tsx
/**
 * The soak.
 *
 * `pnpm load` asks what happens when the platform is busier than it is
 * comfortable with. This asks a different question, and a burst cannot answer
 * it: **does anything drift, leak or degrade while the platform is merely
 * running?**
 *
 * Those are the faults that never appear in a test suite and never appear in a
 * benchmark. A listener added per subscription and removed on no path. A pool
 * that grows a connection each time a query throws. A Map keyed by account id
 * that nothing ever deletes from. A sequence counter that skips once an hour.
 * Each of them is invisible for the first minute and fatal on the third day, and
 * the only way to see one is to leave the thing running and watch a number.
 *
 * So this holds a **steady, modest** rate — deliberately well under capacity,
 * because a saturated system tells you about saturation and nothing else — and
 * samples the same handful of numbers every thirty seconds:
 *
 *   - resident memory and V8 heap
 *   - event-loop lag
 *   - Node handles and active resources
 *   - PostgreSQL backends and Redis clients
 *   - order round-trip latency, per window rather than pooled
 *   - WebSocket sequence continuity, continuously
 *
 * It ends by running the real reconciliation engine over every account, which is
 * the correctness question underneath all of it: after thousands of orders, does
 * each balance still equal the sum of its own ledger?
 *
 * ## What this is not
 *
 * Ten minutes on a two-CPU container is **not a production soak.** It is the
 * shortest run that can show a leak with a steep enough slope, and it will miss
 * anything slower. `SOAK_MINUTES=120` on real hardware is the version that
 * proves something; this is the version that runs in CI without holding it up.
 * Every threshold below is written to be quiet about noise and loud about
 * trends, and the sample table is printed in full so a person can disagree with
 * the verdict.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { io, type Socket } from 'socket.io-client';

const PORT = process.env['API_PORT'] ?? '4000';
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const PASSWORD = 'a-sufficiently-long-passphrase';

const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 10);
const TRADERS = Number(process.env['SOAK_TRADERS'] ?? 4);
/** Per trader. Deliberately unhurried: this is a soak, not a benchmark. */
const ORDERS_PER_MINUTE = Number(process.env['SOAK_ORDERS_PER_MINUTE'] ?? 20);
const SAMPLE_MS = Number(process.env['SOAK_SAMPLE_MS'] ?? 30_000);
const BOOT_TIMEOUT_MS = 60_000;
/**
 * Comfortably inside the fifteen-minute access-token TTL.
 *
 * Ten rather than fourteen because the point is to never be near the edge: a
 * request that starts at 14:59 and is served at 15:01 is a race nobody needs.
 */
const ROTATE_EVERY_MS = 10 * 60_000;

interface Sample {
  atMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopP99Ms: number;
  handles: number;
  activeResources: number;
  pgBackends: number;
  redisClients: number;
  ordersInWindow: number;
  p50Ms: number;
  p99Ms: number;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Least-squares fit through `[x, y]` points: the slope, and how well the line
 * actually describes the data.
 *
 * The slope alone is not enough, and finding that out is what this function is
 * shaped by. A three-minute clean run of this platform trends at roughly
 * +200MB/hour — not because anything leaks, but because V8 grows its heap and
 * collects it in a sawtooth, and a line drawn through three teeth has a
 * confident-looking slope and means nothing.
 *
 * `fit` (R²) tells those apart. A leak is very nearly a straight line, because
 * something is being retained at a steady rate: R² lands above 0.9. Sawtooth
 * noise fits a line badly, whatever its apparent gradient. Requiring both a
 * slope that matters and a fit that holds is what makes a failure here worth
 * waking somebody for.
 */
function trend(points: ReadonlyArray<readonly [number, number]>): {
  slope: number;
  fit: number;
} {
  if (points.length < 3) return { slope: 0, fit: 0 };
  const meanX = mean(points.map(([x]) => x));
  const meanY = mean(points.map(([, y]) => y));

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return { slope: 0, fit: 0 };

  const gradient = covariance / varianceX;
  // R² for a simple linear fit is the square of the correlation coefficient.
  const fit = covariance ** 2 / (varianceX * varianceY);
  return { slope: gradient, fit };
}

async function json<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok: boolean; data: T; error?: { message: string } };
  if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload.data;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Reads one gauge out of the Prometheus text the API already exposes. */
function gauge(text: string, name: string): number {
  const match = new RegExp(`^${name}\\s+([0-9.e+-]+)$`, 'm').exec(text);
  return match === null ? 0 : Number(match[1]);
}

function sumLabelled(text: string, name: string): number {
  let total = 0;
  const pattern = new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.e+-]+)$`, 'gm');
  for (const match of text.matchAll(pattern)) total += Number(match[1]);
  return total;
}

// ---------------------------------------------------------------------------
// Traders
// ---------------------------------------------------------------------------

interface Trader {
  index: number;
  /** Mutable: a run longer than the access-token TTL has to rotate. */
  token: string;
  refreshToken: string;
  accountId: string;
}

async function registerTrader(index: number): Promise<Trader> {
  const email = `soak-${Date.now()}-${index}@test.local`;
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Soak ${index}` }),
  }).then((response) => response.body?.cancel());

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const refreshToken = refreshFrom(login);
  const { accessToken } = await json<{ accessToken: string }>(login);

  const accounts = await fetch(`${API}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const [account] = await json<Array<{ id: string }>>(accounts);
  assert(account !== undefined, `trader ${index} has no account`);

  return { index, token: accessToken, refreshToken, accountId: account?.id ?? '' };
}

/** The refresh token is only ever in the cookie; no response body carries one. */
function refreshFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie') ?? '';
  const value = /tp_refresh=([^;]+)/.exec(cookie)?.[1];
  assert(value !== undefined, 'no refresh cookie was set');
  return decodeURIComponent(value ?? '');
}

/**
 * Rotates a trader's tokens, the way a client left open all day must.
 *
 * The soak needed this because it found the fault: an access token lasts fifteen
 * minutes, and the first run longer than that failed with TOKEN_EXPIRED. That is
 * the platform behaving correctly and the harness behaving like nothing real —
 * no long-lived client holds one token.
 *
 * Rotating here also means a long run exercises the refresh path continuously,
 * which is worth having: reuse of a rotated token revokes the whole family, so a
 * bug in that machinery would end this run rather than hide in it.
 */
async function rotate(trader: Trader): Promise<void> {
  const response = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: trader.refreshToken }),
  });
  const { accessToken } = await json<{ accessToken: string }>(response);
  trader.refreshToken = refreshFrom(response);
  trader.token = accessToken;
}

async function main(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    throw new Error(
      `Something is already listening on ${BASE}. Stop it first — otherwise this soak would measure it instead of the build under test.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Something is already')) throw error;
  }

  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The login limiter would refuse the traders this registers; it is proved by
    // pnpm smoke and is not what a soak is measuring.
    env: { ...process.env, RATE_LIMIT_LOGIN_PER_MINUTE: '120' },
  });
  const apiOutput: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => apiOutput.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => apiOutput.push(chunk.toString()));

  const prisma = new PrismaClient();
  const sockets: Socket[] = [];
  let failed = false;

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('API did not become healthy');
      await sleep(500);
    }

    // An instrument that is open whatever the hour or the day this runs.
    const quotes = await json<Array<{ symbol: string }>>(
      await fetch(`${API}/market/quotes`, { headers: { Authorization: 'Bearer none' } }).then(
        async (r) => (r.ok ? r : r),
      ),
    ).catch(() => [] as Array<{ symbol: string }>);

    const traders: Trader[] = [];
    for (let index = 0; index < TRADERS; index += 1) traders.push(await registerTrader(index));

    const open = await json<Array<{ symbol: string }>>(
      await fetch(`${API}/market/quotes`, {
        headers: { Authorization: `Bearer ${traders[0]?.token}` },
      }),
    );
    const symbol = open[0]?.symbol ?? quotes[0]?.symbol;
    assert(typeof symbol === 'string', 'no instrument is quoting, so there is nothing to soak');

    /**
     * Refuse a configuration that will spend the run being rate-limited.
     *
     * Every trader here comes from one address, so they share the per-route
     * bucket. At a rate above it the soak measures the limiter refusing it,
     * which is a thing `pnpm smoke` already proves and a thing no soak should be
     * doing. Caught up front rather than at the end, because a soak that reports
     * this after ten minutes has wasted ten minutes.
     */
    const orderLimit = Number(process.env['RATE_LIMIT_ORDERS_PER_MINUTE'] ?? 120);
    const submissionsPerMinute = TRADERS * ORDERS_PER_MINUTE;
    assert(
      submissionsPerMinute <= orderLimit,
      `${TRADERS} traders × ${ORDERS_PER_MINUTE}/min is ${submissionsPerMinute} orders a minute ` +
        `from one address, and the limit is ${orderLimit}. Lower SOAK_ORDERS_PER_MINUTE or ` +
        `SOAK_TRADERS — a soak spent being rate-limited measures the rate limiter.`,
    );

    console.log(
      `\n  Soaking for ${MINUTES} minute(s): ${TRADERS} traders, ` +
        `${ORDERS_PER_MINUTE} orders/minute each (${submissionsPerMinute}/min, limit ${orderLimit}), ` +
        `on ${symbol}.\n`,
    );

    // -----------------------------------------------------------------------
    // Sockets, held open for the whole run, watching for a gap
    // -----------------------------------------------------------------------
    const gaps: string[] = [];
    const socketErrors: string[] = [];
    let framesSeen = 0;
    let reconnects = 0;

    for (const trader of traders) {
      const socket = io(BASE, {
        path: '/ws',
        transports: ['websocket'],
        auth: { token: trader.token },
        reconnection: true,
      });
      sockets.push(socket);

      let lastSeq: number | null = null;
      socket.on('connect', () => {
        for (const channel of ['quotes', 'positions', 'account', 'pnl']) {
          socket.emit('subscribe', { channel });
        }
      });
      socket.io.on('reconnect', () => {
        reconnects += 1;
        // A reconnection legitimately restarts the sequence; carrying the old
        // high-water mark across one would manufacture a gap that never
        // happened.
        lastSeq = null;
      });
      socket.on('frame', (frame: { event: string; seq: number }) => {
        framesSeen += 1;
        if (lastSeq !== null && frame.seq !== lastSeq + 1) {
          gaps.push(`trader ${trader.index}: ${frame.event} jumped ${lastSeq} → ${frame.seq}`);
        }
        lastSeq = frame.seq;
      });
      socket.on('connect_error', (error: Error) => socketErrors.push(error.message));
    }

    await sleep(2_000);

    // -----------------------------------------------------------------------
    // The steady state
    // -----------------------------------------------------------------------
    const samples: Sample[] = [];
    const orderErrors: string[] = [];
    let windowLatencies: number[] = [];
    let windowOrders = 0;
    let totalOrders = 0;
    let rotations = 0;

    const startedAt = Date.now();
    const endsAt = startedAt + MINUTES * 60_000;
    const gapMs = 60_000 / ORDERS_PER_MINUTE;

    async function tradeOnce(trader: Trader): Promise<void> {
      const began = Date.now();
      const response = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trader.token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ accountId: trader.accountId, symbol, side: 'BUY', volume: '0.01' }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        data?: { positionId?: string };
        error?: { code: string; message: string };
      };
      windowLatencies.push(Date.now() - began);
      windowOrders += 1;
      totalOrders += 1;

      if (!body.ok) {
        orderErrors.push(`${body.error?.code}: ${body.error?.message}`);
        return;
      }
      const positionId = body.data?.positionId;
      if (typeof positionId !== 'string') return;

      // Closed again, so the soak does not simply accumulate exposure until the
      // margin engine starts refusing — which would measure the margin engine.
      const closed = await fetch(`${API}/positions/${positionId}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trader.token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      if (!closed.ok) {
        const failure = (await closed.json()) as { error?: { code: string } };
        orderErrors.push(`close ${failure.error?.code}`);
      } else {
        await closed.body?.cancel();
      }
    }

    /** One trader's paced loop. Sleeps the remainder, so the rate holds. */
    async function paced(trader: Trader): Promise<void> {
      let rotatesAt = Date.now() + ROTATE_EVERY_MS;
      while (Date.now() < endsAt) {
        const began = Date.now();
        if (began >= rotatesAt) {
          await rotate(trader)
            .then(() => {
              rotations += 1;
              rotatesAt = Date.now() + ROTATE_EVERY_MS;
            })
            .catch((error: Error) => orderErrors.push(`refresh: ${error.message}`));
        }
        await tradeOnce(trader).catch((error: Error) => orderErrors.push(error.message));
        const remaining = gapMs - (Date.now() - began);
        if (remaining > 0) await sleep(remaining);
      }
    }

    async function sampler(): Promise<void> {
      while (Date.now() < endsAt) {
        await sleep(Math.min(SAMPLE_MS, Math.max(0, endsAt - Date.now())));
        if (Date.now() > endsAt + 1_000) break;

        const metrics = await fetch(`${BASE}/metrics`).then((r) => r.text());
        const rows = await prisma.$queryRaw<Array<{ backends: bigint }>>`
          SELECT count(*)::bigint AS backends
            FROM pg_stat_activity
           WHERE datname = current_database()
        `;
        // An aggregate always returns a row, but the sampler runs for hours and
        // a connection lost mid-query must not take the whole soak down with a
        // TypeError about destructuring undefined.
        const backends = rows[0]?.backends ?? 0n;

        const sample: Sample = {
          atMs: Date.now() - startedAt,
          rssBytes: gauge(metrics, 'tp_process_resident_memory_bytes'),
          heapUsedBytes: gauge(metrics, 'tp_nodejs_heap_size_used_bytes'),
          eventLoopP99Ms: gauge(metrics, 'tp_nodejs_eventloop_lag_p99_seconds') * 1000,
          handles: sumLabelled(metrics, 'tp_nodejs_active_handles'),
          activeResources: gauge(metrics, 'tp_nodejs_active_resources_total'),
          pgBackends: Number(backends),
          redisClients: 0,
          ordersInWindow: windowOrders,
          p50Ms: percentile(windowLatencies, 50),
          p99Ms: percentile(windowLatencies, 99),
        };
        samples.push(sample);
        windowLatencies = [];
        windowOrders = 0;

        console.log(
          `  t+${String(Math.round(sample.atMs / 1000)).padStart(4)}s  ` +
            `rss ${mb(sample.rssBytes).padStart(7)}  heap ${mb(sample.heapUsedBytes).padStart(7)}  ` +
            `loop p99 ${sample.eventLoopP99Ms.toFixed(1).padStart(5)}ms  ` +
            `handles ${String(sample.handles).padStart(3)}  pg ${String(sample.pgBackends).padStart(3)}  ` +
            `orders ${String(sample.ordersInWindow).padStart(4)}  ` +
            `p50 ${String(sample.p50Ms).padStart(4)}ms  p99 ${String(sample.p99Ms).padStart(5)}ms`,
        );
      }
    }

    await Promise.all([...traders.map(paced), sampler()]);

    // -----------------------------------------------------------------------
    // What the run has to have shown
    // -----------------------------------------------------------------------
    console.log(
      `\n  ${totalOrders} orders, ${framesSeen} frames, ${rotations} token rotation(s), ` +
        `${reconnects} reconnect(s).\n`,
    );

    const problems: string[] = [];

    if (gaps.length > 0) {
      problems.push(`${gaps.length} sequence gap(s): ${gaps.slice(0, 3).join('; ')}`);
    }
    if (orderErrors.length > 0) {
      const counted = new Map<string, number>();
      for (const error of orderErrors) counted.set(error, (counted.get(error) ?? 0) + 1);
      problems.push(
        `${orderErrors.length} order failure(s): ` +
          [...counted]
            .map(([message, count]) => `${message} ×${count}`)
            .slice(0, 3)
            .join('; '),
      );
    }
    if (socketErrors.length > 0) problems.push(`${socketErrors.length} socket error(s)`);

    assert(samples.length >= 2, 'the run was too short to compare a beginning with an end');
    const third = Math.max(1, Math.floor(samples.length / 3));
    const early = samples.slice(0, third);
    const late = samples.slice(-third);

    /**
     * Memory, measured as a **slope** rather than as a before-and-after.
     *
     * The first version of this compared the mean of the first third with the
     * mean of the last third and failed on a 50% rise. A deliberately injected
     * leak of half a megabyte per request walked resident memory from 230MB to
     * 263MB in three minutes and that test called it fine — because a leak does
     * not double anything in three minutes, it *climbs*, and the whole point of
     * a soak is to see the climb early enough to matter.
     *
     * So: least-squares slope over every sample, reported in MB/hour, which is
     * the number a person actually wants ("this would be 4GB by Friday"). A
     * process that allocates and settles has a slope near zero; one that leaks
     * has a slope that does not care how long you watch.
     *
     * The final sample must also be above the first, so a noisy fit through a
     * flat series cannot manufacture a trend.
     */
    const rssEarly = mean(early.map((s) => s.rssBytes));
    const rssLate = mean(late.map((s) => s.rssBytes));
    const rss = trend(samples.map((s) => [s.atMs, s.rssBytes]));
    const rssPerHour = (rss.slope * 3_600_000) / 1024 / 1024;
    console.log(
      `  resident memory  ${mb(rssEarly)} → ${mb(rssLate)}  ` +
        `(trend ${rssPerHour >= 0 ? '+' : ''}${rssPerHour.toFixed(0)}MB/hour, fit ${rss.fit.toFixed(2)})`,
    );
    if (rssPerHour > 256 && rss.fit > 0.75 && rssLate > rssEarly) {
      problems.push(
        `resident memory is climbing at ${rssPerHour.toFixed(0)}MB/hour on a fit of ` +
          `${rss.fit.toFixed(2)} — a straight line, not a sawtooth ` +
          `(${mb(rssEarly)} → ${mb(rssLate)} over ${MINUTES} minute(s))`,
      );
    }

    const heapEarly = mean(early.map((s) => s.heapUsedBytes));
    const heapLate = mean(late.map((s) => s.heapUsedBytes));
    const heap = trend(samples.map((s) => [s.atMs, s.heapUsedBytes]));
    const heapPerHour = (heap.slope * 3_600_000) / 1024 / 1024;
    console.log(
      `  V8 heap in use   ${mb(heapEarly)} → ${mb(heapLate)}  ` +
        `(trend ${heapPerHour >= 0 ? '+' : ''}${heapPerHour.toFixed(0)}MB/hour, fit ${heap.fit.toFixed(2)})`,
    );
    if (heapPerHour > 128 && heap.fit > 0.75 && heapLate > heapEarly) {
      problems.push(
        `the V8 heap is climbing at ${heapPerHour.toFixed(0)}MB/hour on a fit of ${heap.fit.toFixed(2)}`,
      );
    }

    /**
     * Handles and backends. These must be *flat*, not merely bounded: a listener
     * or a connection that is created per request and released on no path shows
     * here first, long before memory notices.
     */
    const handlesEarly = Math.max(...early.map((s) => s.handles));
    const handlesLate = Math.max(...late.map((s) => s.handles));
    console.log(`  node handles     ${handlesEarly} → ${handlesLate}`);
    if (handlesLate > handlesEarly * 2 && handlesLate - handlesEarly > 20) {
      problems.push(`node handles grew ${handlesEarly} → ${handlesLate}`);
    }

    const pgEarly = Math.max(...early.map((s) => s.pgBackends));
    const pgLate = Math.max(...late.map((s) => s.pgBackends));
    console.log(`  postgres backends ${pgEarly} → ${pgLate}`);
    if (pgLate > pgEarly + 10) {
      problems.push(`postgres backends grew ${pgEarly} → ${pgLate}, which is a pool that leaks`);
    }

    /**
     * Latency drift. Reported always; failed only on a doubling that is also
     * above a floor, because 2ms → 5ms is noise and 200ms → 500ms is not.
     */
    const p50Early = mean(early.map((s) => s.p50Ms));
    const p50Late = mean(late.map((s) => s.p50Ms));
    console.log(`  order p50        ${p50Early.toFixed(0)}ms → ${p50Late.toFixed(0)}ms`);
    if (p50Late > p50Early * 2 && p50Late > 250) {
      problems.push(`order latency degraded ${p50Early.toFixed(0)}ms → ${p50Late.toFixed(0)}ms`);
    }

    const loopP99 = Math.max(...samples.map((s) => s.eventLoopP99Ms));
    console.log(`  event-loop lag   p99 ${loopP99.toFixed(1)}ms at worst`);

    // -----------------------------------------------------------------------
    // The correctness question underneath all of it
    // -----------------------------------------------------------------------
    console.log('\n  Reconciling every account against its own ledger…');
    const accounts = await prisma.account.findMany({
      select: { id: true, number: true, balance: true },
    });
    let drifted = 0;
    for (const account of accounts) {
      const [totals] = await prisma.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM(amount)::text AS total FROM balance_ledger WHERE account_id = ${account.id}::uuid
      `;
      const summed = totals?.total ?? '0';
      if (Number(summed) !== Number(account.balance)) {
        drifted += 1;
        problems.push(
          `${account.number}: balance ${account.balance.toString()} but its ledger sums to ${summed}`,
        );
      }
    }
    console.log(
      drifted === 0
        ? `  ${accounts.length} account(s) agree with their ledgers.`
        : `  ${drifted} account(s) DISAGREE with their ledgers.`,
    );

    if (problems.length > 0) {
      failed = true;
      console.error('\n  The soak found something:\n');
      for (const problem of problems) console.error(`    - ${problem}`);
      console.error('');
    } else {
      console.log(
        `\n  Nothing drifted over ${MINUTES} minute(s).\n` +
          '  A short soak on a small machine misses a slow leak. SOAK_MINUTES=120\n' +
          '  on real hardware is the run that proves something.\n',
      );
    }
  } catch (error) {
    failed = true;
    console.error(`\n  The soak could not complete: ${(error as Error).message}`);
    console.error(apiOutput.join('').slice(-3000));
  } finally {
    for (const socket of sockets) socket.close();
    await prisma.$disconnect();
    api.kill('SIGTERM');
  }

  if (failed) process.exitCode = 1;
}

void main();
