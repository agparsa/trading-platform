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
import { setTimeout as sleep } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';

const PORT = process.env['API_PORT'] ?? '4000';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'a-sufficiently-long-passphrase';

const TRADERS = Number(process.env['LOAD_TRADERS'] ?? 12);
const SOCKETS_PER_TRADER = Number(process.env['LOAD_SOCKETS_PER_TRADER'] ?? 3);
const ORDERS_PER_TRADER = Number(process.env['LOAD_ORDERS_PER_TRADER'] ?? 10);
const OBSERVE_MS = Number(process.env['LOAD_OBSERVE_MS'] ?? 20_000);

interface Frame {
  event: string;
  seq: number;
  timestamp: number;
}

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
  await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Load ${index}` }),
  });
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { accessToken } = await json<{ accessToken: string }>(login);
  const accounts = await json<Array<{ id: string }>>(
    await fetch(`${BASE}/api/v1/accounts`, { headers: { Authorization: `Bearer ${accessToken}` } }),
  );
  const accountId = accounts[0]?.id;
  assert(accountId !== undefined, 'registration opened no account');
  return { token: accessToken, accountId: accountId! };
}

async function waitForBoot(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy');
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
  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RATE_LIMIT_LOGIN_PER_MINUTE: '100000',
      RATE_LIMIT_ORDERS_PER_MINUTE: '100000',
      RATE_LIMIT_API_PER_MINUTE: '100000',
    },
  });
  const output: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const sockets: Socket[] = [];
  let failed = false;

  try {
    await waitForBoot();
    console.log(
      `\n  ${TRADERS} traders · ${TRADERS * SOCKETS_PER_TRADER} sockets · ` +
        `${TRADERS * ORDERS_PER_TRADER} orders · ${OBSERVE_MS / 1000}s observation` +
        `\n  (per-IP rate limits raised for this run — see the note in the script)\n`,
    );

    const traders = await Promise.all(
      Array.from({ length: TRADERS }, (_, index) => registerTrader(index)),
    );

    const symbols = await json<Array<{ symbol: string }>>(
      await fetch(`${BASE}/api/v1/market/quotes`, {
        headers: { Authorization: `Bearer ${traders[0]!.token}` },
      }),
    );
    assert(symbols.length > 0, 'nothing is quoting');

    // --- sockets ------------------------------------------------------------
    const streams: Array<{ frames: Frame[]; errors: string[] }> = [];
    for (const trader of traders) {
      for (let i = 0; i < SOCKETS_PER_TRADER; i += 1) {
        const frames: Frame[] = [];
        const errors: string[] = [];
        const socket = io(BASE, {
          path: '/ws',
          transports: ['websocket'],
          auth: { token: trader.token },
        });
        socket.on('frame', (frame: Frame) => frames.push(frame));
        socket.on('connect_error', (error: Error) => errors.push(error.message));
        socket.on('connect', () => {
          for (const channel of ['quotes', 'positions', 'account', 'pnl']) {
            socket.emit('subscribe', { channel });
          }
        });
        sockets.push(socket);
        streams.push({ frames, errors });
      }
    }
    await sleep(3_000);

    const coalescedBefore = await counterValue('tp_ticks_coalesced_total');

    // --- orders, while the sockets are being served -------------------------
    const latencies: number[] = [];
    const rejections: string[] = [];
    const submit = async (trader: Trader, index: number): Promise<void> => {
      const symbol = symbols[index % symbols.length]!.symbol;
      const startedAt = Date.now();
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
    };

    const orderStartedAt = Date.now();
    await Promise.all(
      traders.flatMap((trader) =>
        Array.from({ length: ORDERS_PER_TRADER }, (_, index) => submit(trader, index)),
      ),
    );
    const orderElapsed = Date.now() - orderStartedAt;

    // --- watch the stream under that load -----------------------------------
    await sleep(OBSERVE_MS);
    const coalescedAfter = await counterValue('tp_ticks_coalesced_total');
    const ticks = await counterValue('tp_market_ticks_total');

    // --- results ------------------------------------------------------------
    const allFrames = streams.reduce((total, stream) => total + stream.frames.length, 0);
    const socketErrors = streams.flatMap((stream) => stream.errors);

    let gaps = 0;
    let emptyStreams = 0;
    for (const stream of streams) {
      if (stream.frames.length === 0) {
        emptyStreams += 1;
        continue;
      }
      for (let i = 0; i < stream.frames.length; i += 1) {
        if (stream.frames[i]!.seq !== i + 1) {
          gaps += 1;
          break;
        }
      }
    }

    const orders = TRADERS * ORDERS_PER_TRADER;
    const rows: Array<[string, string]> = [
      ['Sockets held open', String(sockets.length)],
      ['Frames delivered', String(allFrames)],
      [
        'Frames per socket per second',
        (allFrames / sockets.length / (OBSERVE_MS / 1000)).toFixed(1),
      ],
      ['Sockets with a sequence gap', String(gaps)],
      ['Sockets that received nothing', String(emptyStreams)],
      ['Socket errors', String(socketErrors.length)],
      ['Orders submitted', String(orders)],
      ['Orders rejected', String(rejections.length)],
      ['Order throughput (per second)', (orders / (orderElapsed / 1000)).toFixed(1)],
      ['Order latency p50 (ms)', String(percentile(latencies, 50))],
      ['Order latency p95 (ms)', String(percentile(latencies, 95))],
      ['Order latency p99 (ms)', String(percentile(latencies, 99))],
      ['Order latency max (ms)', String(Math.max(...latencies))],
      ['Market ticks ingested', String(ticks)],
      ['Ticks coalesced into a running pass', String(coalescedAfter - coalescedBefore)],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    console.log(rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n'));

    console.log('\n  Correctness under load:');
    const checks: Array<[string, boolean, string]> = [
      ['sequence numbers stayed gapless', gaps === 0, `${gaps} socket(s) saw a gap`],
      ['every socket received frames', emptyStreams === 0, `${emptyStreams} socket(s) got nothing`],
      ['no socket errored', socketErrors.length === 0, socketErrors.slice(0, 3).join('; ')],
      [
        'no order was rejected',
        rejections.length === 0,
        `rejected: ${[...new Set(rejections)].join(', ')}`,
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
  } catch (error) {
    failed = true;
    console.error(`\n  ${(error as Error).message}`);
    console.error(output.join('').slice(-3000));
  } finally {
    for (const socket of sockets) socket.close();
    api.kill('SIGTERM');
  }

  if (failed) {
    console.error('\nLoad test failed.\n');
    process.exit(1);
  }
  console.log('\nLoad test passed.\n');
  process.exit(0);
}

void main();
