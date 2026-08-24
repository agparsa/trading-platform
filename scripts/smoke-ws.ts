/**
 * WebSocket smoke test.
 *
 * Boots the compiled API and drives a real Socket.IO client against it. The
 * gateway cannot be exercised from the unit suite — Vitest's esbuild transform
 * drops the decorator metadata Nest needs — so this is the only place the
 * realtime path is proven end to end.
 *
 * What it checks is the contract in docs/websocket.md: frames arrive, sequence
 * numbers are gapless, private channels are refused without a token, and one
 * account's data never reaches another socket.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';

const PORT = process.env['API_PORT'] ?? '4000';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'a-sufficiently-long-passphrase';

interface Frame {
  event: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: number;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok: boolean; data: T; error?: { message: string } };
  if (!payload.ok) throw new Error(`${path} failed: ${payload.error?.message ?? response.status}`);
  return payload.data;
}

async function get<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = (await response.json()) as { ok: boolean; data: T };
  return payload.data;
}

async function registerTrader(label: string): Promise<{ token: string; accountId: string }> {
  const email = `ws-${label}-${Date.now()}-${(process.hrtime.bigint() % 100000n).toString()}@test.local`;
  await post('/api/v1/auth/register', { email, password: PASSWORD, displayName: label });
  const tokens = await post<{ accessToken: string }>('/api/v1/auth/login', {
    email,
    password: PASSWORD,
  });
  const accounts = await get<Array<{ id: string }>>('/api/v1/accounts', tokens.accessToken);
  const accountId = accounts[0]?.id;
  assert(accountId !== undefined, 'registration did not open an account');
  return { token: tokens.accessToken, accountId: accountId! };
}

function connect(token?: string): { socket: Socket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = io(BASE, {
    path: '/ws',
    transports: ['websocket'],
    ...(token === undefined ? {} : { auth: { token } }),
  });
  socket.on('frame', (frame: Frame) => frames.push(frame));
  return { socket, frames };
}

const waitFor = async <T>(probe: () => T | undefined, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/**
 * Refuses to run if something is already listening.
 *
 * This script spawns its own API. If a stale instance already holds the port,
 * the spawned one fails to bind, the checks quietly hit the old binary, and the
 * run goes green against code that is not the code under test. That is the worst
 * possible failure mode for a smoke test, so it is made impossible rather than
 * documented.
 */
async function assertPortFree(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return; // nothing listening, which is what we want
  }
  throw new Error(
    `Something is already listening on ${BASE}. Stop it first — otherwise this smoke test would run against it instead of the build under test.`,
  );
}

async function main(): Promise<void> {
  await assertPortFree();

  const api = spawn('node', ['apps/api/dist/main.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  api.stdout.on('data', (c: Buffer) => output.push(c.toString()));
  api.stderr.on('data', (c: Buffer) => output.push(c.toString()));

  const sockets: Socket[] = [];
  let failures = 0;
  const check = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${name}: ${(error as Error).message}`);
    }
  };

  try {
    // Wait for the API to answer.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) throw new Error('API did not become healthy');
      await sleep(500);
    }

    const alice = await registerTrader('alice');
    const bob = await registerTrader('bob');

    await check('public quotes reach an unauthenticated socket', async () => {
      const { socket, frames } = connect();
      sockets.push(socket);
      await waitFor(() => (socket.connected ? true : undefined), 10_000, 'connection');
      socket.emit('subscribe', { channel: 'quotes' });
      const frame = await waitFor(
        () => frames.find((f) => f.event === 'quote.update'),
        20_000,
        'a quote',
      );
      assert(typeof frame.data['bid'] === 'string', 'bid was not a decimal string');
      assert(typeof frame.data['ask'] === 'string', 'ask was not a decimal string');
    });

    await check('a private channel is refused without a token', async () => {
      const { socket } = connect();
      sockets.push(socket);
      await waitFor(() => (socket.connected ? true : undefined), 10_000, 'connection');
      const reply = await socket.emitWithAck('subscribe', { channel: 'positions' });
      const result = reply as { ok: boolean; error?: string };
      assert(result.ok === false, 'an unauthenticated socket was allowed onto a private channel');
    });

    await check('sequence numbers are gapless and monotonic', async () => {
      const { socket, frames } = connect(alice.token);
      sockets.push(socket);
      await waitFor(() => (socket.connected ? true : undefined), 10_000, 'connection');
      socket.emit('subscribe', { channel: 'quotes' });
      await waitFor(() => (frames.length >= 8 ? true : undefined), 30_000, 'eight frames');
      const seqs = frames.map((f) => f.seq);
      for (let i = 0; i < seqs.length; i += 1) {
        assert(
          seqs[i] === i + 1,
          `sequence broke at index ${i}: got ${seqs[i]}, expected ${i + 1}`,
        );
      }
    });

    await check('opening a position pushes position, account and pnl frames', async () => {
      const { socket, frames } = connect(alice.token);
      sockets.push(socket);
      await waitFor(() => (socket.connected ? true : undefined), 10_000, 'connection');
      for (const channel of ['positions', 'account', 'pnl']) {
        socket.emit('subscribe', { channel });
      }
      await sleep(500);

      const quotes = await get<Array<{ symbol: string }>>('/api/v1/market/quotes', alice.token);
      const symbol = quotes[0]?.symbol;
      assert(symbol !== undefined, 'nothing is quoting');

      await post(
        '/api/v1/orders',
        { accountId: alice.accountId, symbol, side: 'BUY', volume: '0.01' },
        alice.token,
        `ws-open-${Date.now()}`,
      );

      const created = await waitFor(
        () => frames.find((f) => f.event === 'position.created'),
        15_000,
        'position.created',
      );
      assert(created.data['symbol'] === symbol, 'the frame described a different symbol');

      await waitFor(
        () => frames.find((f) => f.event === 'account.updated'),
        20_000,
        'account.updated',
      );
      await waitFor(() => frames.find((f) => f.event === 'pnl.updated'), 20_000, 'pnl.updated');
    });

    await check("one account's private frames never reach another socket", async () => {
      const { socket: bobSocket, frames: bobFrames } = connect(bob.token);
      sockets.push(bobSocket);
      await waitFor(() => (bobSocket.connected ? true : undefined), 10_000, 'connection');
      for (const channel of ['positions', 'account', 'pnl']) {
        bobSocket.emit('subscribe', { channel });
      }
      await sleep(500);

      const quotes = await get<Array<{ symbol: string }>>('/api/v1/market/quotes', alice.token);
      await post(
        '/api/v1/orders',
        { accountId: alice.accountId, symbol: quotes[0]!.symbol, side: 'BUY', volume: '0.01' },
        alice.token,
        `ws-leak-${Date.now()}`,
      );
      await sleep(3_000);

      const leaked = bobFrames.filter(
        (f) => f.event.startsWith('position.') || f.event === 'account.updated',
      );
      assert(
        leaked.length === 0,
        `Bob received ${leaked.length} private frame(s) belonging to Alice: ${leaked.map((f) => f.event).join(', ')}`,
      );
    });

    await check('whoami reports what the server believes about the socket', async () => {
      const { socket } = connect(alice.token);
      sockets.push(socket);
      await waitFor(() => (socket.connected ? true : undefined), 10_000, 'connection');
      socket.emit('subscribe', { channel: 'quotes' });
      const reply = (await socket.emitWithAck('whoami', {})) as {
        authenticated: boolean;
        accounts: number;
        channels: string[];
      };
      assert(reply.authenticated, 'an authenticated socket reported itself as anonymous');
      assert(reply.accounts >= 1, 'the socket resolved no accounts');
      assert(reply.channels.includes('quotes'), 'the subscription was not recorded');
    });
  } catch (error) {
    failures += 1;
    console.error((error as Error).message);
    console.error(output.join('').slice(-3000));
  } finally {
    for (const socket of sockets) socket.close();
    api.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} WebSocket check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll WebSocket checks passed.');
  }
}

void main();
