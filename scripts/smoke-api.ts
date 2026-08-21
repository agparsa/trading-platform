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

async function main(): Promise<void> {
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
