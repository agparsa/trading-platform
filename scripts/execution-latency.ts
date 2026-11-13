/**
 * Execution latency, measured the way a trader feels it.
 *
 * `pnpm load` answers whether the platform stays correct when it is busy. This
 * answers a narrower question: from the moment a trader's request leaves the
 * device, how long until (a) the server answers it and (b) the confirming
 * WebSocket frame arrives — the two moments a screen may say "filled",
 * "moved" or "closed". For three commands: a market open, a stop-loss move and
 * a full close, each confirmed by its own frame (`position.created`,
 * `position.updated`, `position.closed`).
 *
 * Against a running API (`TP_BASE`, default http://127.0.0.1:4000), with
 * `LATENCY_BACKGROUND` other traders placing and closing orders continuously
 * so the numbers are not those of an idle box. Where the server's own stage
 * histogram is reachable (`/metrics`), the mean time per stage — received,
 * validated, priced, executed — for this run's orders is printed beside them.
 *
 * Run it against an API whose rate limits are raised for the run (as
 * `pnpm load` does — RATE_LIMIT_LOGIN_PER_MINUTE, _ORDERS_, _API_ and
 * _SOCKET_MESSAGES_): otherwise the throttler, not the engine, is measured.
 *
 * Printed, never asserted, and never invented: every figure below is a
 * difference of two `performance.now()` readings in this process, or a delta
 * of the server's own counters. Network distance to a remote server is part of
 * what is measured when `TP_BASE` points at one — which is the point.
 *
 *   pnpm tsx scripts/execution-latency.ts
 *   TP_BASE=http://127.0.0.1:4000 LATENCY_SAMPLES=100 LATENCY_BACKGROUND=10 pnpm tsx scripts/execution-latency.ts
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';

const BASE = process.env['TP_BASE'] ?? 'http://127.0.0.1:4000';
const SAMPLES = Number(process.env['LATENCY_SAMPLES'] ?? 60);
const BACKGROUND = Number(process.env['LATENCY_BACKGROUND'] ?? 8);
const SYMBOL = process.env['LATENCY_SYMBOL'] ?? 'XAUUSD';
const PASSWORD = 'a-sufficiently-long-passphrase';
/** A frame that has not come in this long is reported as missing, not waited for. */
const FRAME_TIMEOUT_MS = 10_000;
/**
 * Time between the probe's round trips. Each is three trading actions, and an
 * account may take 120 a minute — a business rule
 * this probe has no business switching off, so it paces itself under it.
 */
const PACE_MS = Number(process.env['LATENCY_PACE_MS'] ?? 1_600);

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

interface Trader {
  token: string;
  accountId: string;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function call<T>(
  trader: Trader | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(trader === null ? {} : { Authorization: `Bearer ${trader.token}` }),
      ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as {
    ok: boolean;
    data: T;
    error?: { code?: string; message: string };
  };
  if (!payload.ok) {
    throw new Error(
      `${method} ${path}: ${payload.error?.code ?? response.status} ${payload.error?.message ?? ''}`,
    );
  }
  return payload.data;
}

async function register(label: string): Promise<Trader> {
  const email = `latency-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  await call(null, 'POST', '/auth/register', { email, password: PASSWORD, displayName: label });
  const { accessToken } = await call<{ accessToken: string }>(null, 'POST', '/auth/login', {
    email,
    password: PASSWORD,
  });
  const token = { token: accessToken, accountId: '' };
  const accounts = await call<Array<{ id: string }>>(token, 'GET', '/accounts');
  const accountId = accounts[0]?.id;
  if (accountId === undefined) throw new Error('registration opened no account');
  return { token: accessToken, accountId };
}

/** Frames this trader's socket has received, waited on by predicate. */
class Inbox {
  private readonly waiting: Array<{
    match: (frame: Frame) => boolean;
    done: (at: number) => void;
  }> = [];
  constructor(socket: Socket) {
    socket.on('frame', (frame: Frame) => {
      const at = performance.now();
      for (let i = this.waiting.length - 1; i >= 0; i -= 1) {
        if (this.waiting[i]!.match(frame)) {
          this.waiting[i]!.done(at);
          this.waiting.splice(i, 1);
        }
      }
    });
  }
  /** Resolves with the arrival time, or `null` after FRAME_TIMEOUT_MS. */
  next(match: (frame: Frame) => boolean): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), FRAME_TIMEOUT_MS);
      this.waiting.push({
        match,
        done: (at) => {
          clearTimeout(timer);
          resolve(at);
        },
      });
    });
  }
}

async function connect(trader: Trader): Promise<{ socket: Socket; inbox: Inbox }> {
  const socket = io(BASE, {
    path: '/ws',
    transports: ['websocket'],
    auth: { token: trader.token },
  });
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  for (const channel of ['orders', 'positions']) socket.emit('subscribe', { channel });
  await sleep(300);
  return { socket, inbox };
}

/** Stage sums and counts from the server's own histogram, when it is reachable. */
async function stageTotals(): Promise<Map<string, { sum: number; count: number }> | null> {
  try {
    const text = await (
      await fetch(`${BASE}/metrics`, { signal: AbortSignal.timeout(15_000) })
    ).text();
    const totals = new Map<string, { sum: number; count: number }>();
    for (const line of text.split('\n')) {
      const found =
        /^tp_order_stage_seconds_(sum|count)\{[^}]*stage="(\w+)"[^}]*\} ([\d.eE+-]+)$/.exec(line);
      if (found === null) continue;
      const entry = totals.get(found[2]!) ?? { sum: 0, count: 0 };
      entry[found[1] as 'sum' | 'count'] += Number(found[3]);
      totals.set(found[2]!, entry);
    }
    return totals.size === 0 ? null : totals;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (health === null || !health.ok) throw new Error(`${BASE}/health is not answering`);

  const probe = await register('probe');
  const { socket, inbox } = await connect(probe);

  const stagesBefore = await stageTotals();

  // --- background: other traders trading, so this is not an idle box --------
  let running = true;
  let backgroundOrders = 0;
  const backgroundErrors: string[] = [];
  // One at a time: registration is rate limited, and this is not its test.
  const background: Trader[] = [];
  for (let i = 0; i < BACKGROUND; i += 1) background.push(await register(`bg${i}`));
  const loops = background.map(async (trader) => {
    while (running) {
      // An open and a close a second: inside the per-account action limit,
      // so the background is load on the engine rather than on the throttler.
      const turn = sleep(1_100);
      try {
        const ack = await call<{ positionId: string | null }>(trader, 'POST', '/orders', {
          accountId: trader.accountId,
          symbol: SYMBOL,
          side: Math.random() < 0.5 ? 'BUY' : 'SELL',
          volume: '0.01',
        });
        backgroundOrders += 1;
        if (ack.positionId !== null) {
          await call(trader, 'POST', `/positions/${ack.positionId}/close`, {});
        }
      } catch (error) {
        backgroundErrors.push(error instanceof Error ? error.message : String(error));
      }
      await turn;
    }
  });

  const rows = {
    openAck: [] as number[],
    openFrame: [] as number[],
    modifyAck: [] as number[],
    modifyFrame: [] as number[],
    closeAck: [] as number[],
    closeFrame: [] as number[],
  };
  let missingFrames = 0;
  const refusals: string[] = [];

  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    try {
      // Open.
      let positionId: string | null = null;
      const openSent = performance.now();
      const created = inbox.next(
        (frame) => frame.event === 'position.created' && frame.data['symbol'] === SYMBOL,
      );
      const ack = await call<{ positionId: string | null; price: string }>(
        probe,
        'POST',
        '/orders',
        {
          accountId: probe.accountId,
          symbol: SYMBOL,
          side: 'BUY',
          volume: '0.01',
        },
      );
      rows.openAck.push(performance.now() - openSent);
      positionId = ack.positionId;
      const createdAt = await created;
      if (createdAt === null) missingFrames += 1;
      else rows.openFrame.push(createdAt - openSent);
      if (positionId === null) throw new Error('market order opened no position');

      // Move the stop: 1% under the fill, which any buy accepts.
      const stop = (Number(ack.price) * 0.99).toFixed(2);
      const modifySent = performance.now();
      const updated = inbox.next(
        (frame) => frame.event === 'position.updated' && frame.data['positionId'] === positionId,
      );
      await call(probe, 'PATCH', `/positions/${positionId}`, { stopLoss: stop });
      rows.modifyAck.push(performance.now() - modifySent);
      const updatedAt = await updated;
      if (updatedAt === null) missingFrames += 1;
      else rows.modifyFrame.push(updatedAt - modifySent);

      // Close.
      const closeSent = performance.now();
      const closed = inbox.next(
        (frame) => frame.event === 'position.closed' && frame.data['positionId'] === positionId,
      );
      await call(probe, 'POST', `/positions/${positionId}/close`, {});
      rows.closeAck.push(performance.now() - closeSent);
      const closedAt = await closed;
      if (closedAt === null) missingFrames += 1;
      else rows.closeFrame.push(closedAt - closeSent);
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
    await sleep(Math.max(0, PACE_MS - (performance.now() - started)));
  }

  const stagesAfter = await stageTotals();
  running = false;
  await Promise.all(loops);
  socket.close();

  const fmt = (value: number | null) => (value === null ? '—' : `${value.toFixed(0)} ms`);
  const line = (label: string, values: number[]) =>
    `${label.padEnd(38)} n=${String(values.length).padStart(3)}  p50 ${fmt(percentile(values, 50)).padStart(7)}  p95 ${fmt(percentile(values, 95)).padStart(7)}  p99 ${fmt(percentile(values, 99)).padStart(7)}  max ${fmt(values.length === 0 ? null : Math.max(...values)).padStart(7)}`;

  console.log(
    `\nExecution latency against ${BASE} — ${SAMPLES} round trips on ${SYMBOL}, ${BACKGROUND} other traders trading meanwhile (${backgroundOrders} background orders)\n`,
  );
  console.log(line('Open: request → server answer', rows.openAck));
  console.log(line('Open: request → position.created frame', rows.openFrame));
  console.log(line('Stop move: request → server answer', rows.modifyAck));
  console.log(line('Stop move: request → position.updated', rows.modifyFrame));
  console.log(line('Close: request → server answer', rows.closeAck));
  console.log(line('Close: request → position.closed frame', rows.closeFrame));

  if (stagesBefore !== null && stagesAfter !== null) {
    console.log(
      '\nServer-side order stages (mean over every order in the run, background included, from tp_order_stage_seconds):',
    );
    for (const [stage, after] of stagesAfter) {
      const before = stagesBefore.get(stage) ?? { sum: 0, count: 0 };
      const count = after.count - before.count;
      if (count <= 0) continue;
      console.log(
        `  ${stage.padEnd(12)} ${(((after.sum - before.sum) / count) * 1000).toFixed(1)} ms  (n=${count})`,
      );
    }
  } else {
    console.log('\nServer-side stages: /metrics not reachable from here — not reported.');
  }

  console.log(`\nMissing confirmation frames: ${missingFrames}`);
  console.log(
    `Probe refusals: ${refusals.length}${refusals.length > 0 ? ` — first: ${refusals[0]}` : ''}`,
  );
  console.log(
    `Background refusals: ${backgroundErrors.length}${backgroundErrors.length > 0 ? ` — first: ${backgroundErrors[0]}` : ''}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
