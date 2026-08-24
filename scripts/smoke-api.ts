/**
 * Post-build smoke test.
 *
 * Boots the compiled API exactly as production runs it and asserts that the
 * things Phase 1 claims to deliver actually respond: liveness, readiness
 * against a real database and Redis, the response envelope, the error envelope
 * and the metrics endpoint. A green unit suite on top of an app that cannot
 * start is not a passing build.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = `http://127.0.0.1:${process.env.API_PORT ?? '4000'}`;
const BOOT_TIMEOUT_MS = 60_000;

interface Check {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${path}`);
  return { status: response.status, body: await response.json() };
}

const checks: Check[] = [
  {
    name: 'liveness responds inside the success envelope',
    run: async () => {
      const { status, body } = await getJson('/health');
      assert(status === 200, `expected 200, got ${status}`);
      const payload = body as {
        ok: boolean;
        data: { status: string };
        meta: { requestId: string };
      };
      assert(payload.ok === true, 'envelope ok flag was not true');
      assert(payload.data.status === 'ok', 'liveness did not report ok');
      assert(typeof payload.meta.requestId === 'string', 'response carried no request id');
    },
  },
  {
    name: 'readiness reports database and redis up',
    run: async () => {
      const { status, body } = await getJson('/ready');
      assert(status === 200, `expected 200, got ${status}`);
      const payload = body as { data: { info: Record<string, { status: string }> } };
      assert(payload.data.info['database']?.status === 'up', 'database not reported up');
      assert(payload.data.info['redis']?.status === 'up', 'redis not reported up');
    },
  },
  {
    name: 'unknown route returns a coded failure envelope, not a stack trace',
    run: async () => {
      const { status, body } = await getJson('/api/v1/definitely-not-a-route');
      assert(status === 404, `expected 404, got ${status}`);
      const payload = body as { ok: boolean; error: { code: string; requestId: string } };
      assert(payload.ok === false, 'failure envelope ok flag was not false');
      assert(payload.error.code === 'RESOURCE_NOT_FOUND', `unexpected code ${payload.error.code}`);
      assert(!JSON.stringify(payload).includes('at Object.'), 'response leaked a stack trace');
    },
  },
  {
    name: 'authentication is on by default — a trading route needs a token',
    run: async () => {
      const { status, body } = await getJson('/api/v1/accounts');
      assert(status === 401, `expected 401, got ${status}`);
      const payload = body as { error: { code: string } };
      assert(payload.error.code === 'UNAUTHENTICATED', `unexpected code ${payload.error.code}`);
    },
  },
  {
    name: 'the market feed is quoting at least one instrument',
    run: async () => {
      // Registration and login exercise the whole account-opening path, and
      // give us a token to read the quote feed with.
      const email = `smoke-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      const register = await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName: 'Smoke Test' }),
      });
      assert(register.status === 202, `register returned ${register.status}`);

      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert(login.ok, `login returned ${login.status}`);
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;

      const accounts = await fetch(`${BASE}/api/v1/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const opened = ((await accounts.json()) as { data: Array<{ balance: string }> }).data;
      assert(opened.length === 1, `expected one account, got ${opened.length}`);

      const quotes = await fetch(`${BASE}/api/v1/market/quotes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const priced = ((await quotes.json()) as { data: unknown[] }).data;
      // At least one instrument must be inside its trading session and quoting;
      // crypto never closes, so this holds at any hour.
      assert(priced.length > 0, 'no instrument is currently quoting');
    },
  },
  {
    name: 'a full round trip: open a position, mark it, close it, check the ledger',
    run: async () => {
      const email = `smoke-trade-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName: 'Smoke Trade' }),
      });
      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const accountsResponse = await fetch(`${BASE}/api/v1/accounts`, { headers: auth });
      const accountId = ((await accountsResponse.json()) as { data: Array<{ id: string }> }).data[0]
        ?.id;
      assert(accountId !== undefined, 'no account was opened at registration');

      // Whichever instrument is currently inside its session; crypto is always one.
      const quotesResponse = await fetch(`${BASE}/api/v1/market/quotes`, { headers: auth });
      const quotes = ((await quotesResponse.json()) as { data: Array<{ symbol: string }> }).data;
      assert(quotes.length > 0, 'nothing is quoting, so no order can be placed');
      const symbol = quotes[0]!.symbol;

      const open = await fetch(`${BASE}/api/v1/orders`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `smoke-open-${Date.now()}` },
        body: JSON.stringify({ accountId, symbol, side: 'BUY', volume: '0.01' }),
      });
      const opened = (await open.json()) as {
        ok: boolean;
        data: { positionId: string };
        error?: { code: string; message: string };
      };
      assert(opened.ok, `order rejected: ${opened.error?.code} ${opened.error?.message}`);

      const stateResponse = await fetch(`${BASE}/api/v1/accounts/${accountId}/state`, {
        headers: auth,
      });
      const state = (await stateResponse.json()) as {
        data: { usedMargin: string; openPositions: number };
      };
      assert(state.data.openPositions === 1, 'the position is not reflected in account state');
      assert(Number(state.data.usedMargin) > 0, 'no margin is being held against the position');

      const close = await fetch(`${BASE}/api/v1/positions/${opened.data.positionId}/close`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `smoke-close-${Date.now()}` },
        body: JSON.stringify({}),
      });
      const closed = (await close.json()) as {
        ok: boolean;
        data: { fullyClosed: boolean; netPnl: string };
        error?: { code: string; message: string };
      };
      assert(closed.ok, `close rejected: ${closed.error?.code} ${closed.error?.message}`);
      assert(closed.data.fullyClosed, 'the position did not fully close');

      const ledgerResponse = await fetch(`${BASE}/api/v1/accounts/${accountId}/ledger`, {
        headers: auth,
      });
      const ledger = (await ledgerResponse.json()) as {
        data: { entries: Array<{ type: string }> };
      };
      const types = ledger.data.entries.map((entry) => entry.type);
      assert(types.includes('DEPOSIT'), 'the opening deposit is missing from the ledger');
      assert(
        types.some((type) => type === 'TRADE_PROFIT' || type === 'TRADE_LOSS'),
        'the closed trade did not reach the ledger',
      );
    },
  },
  {
    name: 'metrics endpoint exposes the declared trading counters',
    run: async () => {
      const response = await fetch(`${BASE}/metrics`);
      assert(response.ok, `metrics returned ${response.status}`);
      const text = await response.text();
      for (const metric of ['tp_orders_submitted_total', 'tp_market_ticks_total']) {
        assert(text.includes(metric), `metrics output is missing ${metric}`);
      }
    },
  },
];

async function waitForBoot(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`API did not become healthy within ${BOOT_TIMEOUT_MS}ms`);
}

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

  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const output: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  let failures = 0;
  try {
    await waitForBoot();
    for (const check of checks) {
      try {
        await check.run();
        console.log(`  ok  ${check.name}`);
      } catch (error) {
        failures += 1;
        console.error(`  FAIL ${check.name}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error((error as Error).message);
    console.error(output.join('').slice(-4000));
  } finally {
    api.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${checks.length} smoke checks passed.`);
  }
}

void main();
