import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildMarker } from '@tp/crypto-core';
import { WORKER_HEARTBEAT_PREFIX, parseWorkerHeartbeat } from '@tp/shared-types';

/**
 * Boots the real worker and watches it stay up.
 *
 * ## Why this exists
 *
 * The worker went into a restart loop in production on the first deploy that
 * carried `BrokerHealthService`, while every one of 1957 tests passed. The
 * cause was one character: a constructor parameter written `secrets?:
 * SecretBox` rather than `@Optional() secrets?: SecretBox`. TypeScript's `?`
 * is erased before Nest sees anything; the container read the parameter's
 * type, found no provider for it, and refused to construct the service — and
 * with it the whole application context.
 *
 * No unit test could have caught that. The suite builds these services by
 * hand (`new BrokerHealthService(prisma, registry, config, secrets)`), which
 * is the right way to test what they *do* and says nothing at all about
 * whether Nest can assemble them. And a `Test.createTestingModule` case would
 * not have caught it either: vitest transforms with esbuild, which does not
 * emit `design:paramtypes`, so the container would have had no types to
 * demand and the test would have passed on a technicality.
 *
 * The only faithful check is the one below — run the built artefact, the way
 * the container runs it, and see whether it lives. `pnpm smoke` has done this
 * for the API since a Zod DTO broke its boot the same way. This is the
 * worker's half, and it should be run before every deploy.
 *
 * ## What "up" means
 *
 * The worker serves no HTTP, so there is no endpoint to poll. It logs
 * `Worker started` once the context is built and every queue is registered,
 * and then it stays running. Both halves matter: a process that logs the line
 * and exits two seconds later is not up, and that is precisely the shape of a
 * crash loop. So this waits for the line, then keeps watching for a while
 * longer and fails if the process leaves.
 */
const BUILD = 'apps/worker/dist/main.js';
const READY = /Worker started/;
const BOOT_TIMEOUT_MS = 45_000;
/** After the ready line: long enough to catch a context that dies behind it. */
const SETTLE_MS = 8_000;

async function main(): Promise<void> {
  if (!existsSync(BUILD)) {
    console.error(
      `${BUILD} does not exist. This check runs the built artefact — the thing ` +
        'the container actually runs — so build first: pnpm --filter @tp/worker build',
    );
    process.exitCode = 1;
    return;
  }

  console.log('  Booting the worker from its build\n');
  const worker = spawn('node', [BUILD], { stdio: ['ignore', 'pipe', 'pipe'] });

  const output: string[] = [];
  let ready = false;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  const record = (chunk: Buffer) => {
    const text = chunk.toString();
    output.push(text);
    if (READY.test(text)) ready = true;
  };
  worker.stdout.on('data', record);
  worker.stderr.on('data', record);
  worker.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!ready && exited === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const fail = (message: string): void => {
    console.error(`  FAIL ${message}`);
    console.error(output.join('').slice(-3000));
    worker.kill('SIGKILL');
    process.exitCode = 1;
  };

  if (exited !== null) {
    const { code, signal } = exited as { code: number | null; signal: NodeJS.Signals | null };
    fail(`the worker exited before it was ready (code ${code}, signal ${signal})`);
    return;
  }
  if (!ready) {
    fail(`the worker did not report itself started within ${BOOT_TIMEOUT_MS}ms`);
    return;
  }
  console.log('  ok  the worker builds its application context and reports started');

  /**
   * Nest logs its errors and then the process leaves, so a context that failed
   * to assemble can still have printed a hopeful line first. Watching after
   * the fact is what tells a boot from a crash loop.
   */
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  if (exited !== null) {
    const { code, signal } = exited as { code: number | null; signal: NodeJS.Signals | null };
    fail(`the worker started and then exited (code ${code}, signal ${signal})`);
    return;
  }
  console.log(`  ok  it is still running ${SETTLE_MS}ms later, not restarting`);

  const errors = output
    .join('')
    .match(/UnknownDependenciesException|UndefinedDependencyException/g);
  if (errors !== null) {
    fail(`the worker logged a dependency error it survived: ${errors.join(', ')}`);
    return;
  }
  console.log('  ok  nothing in its output is a dependency it could not resolve');

  /**
   * It says it is alive, and which build, where the API will look.
   *
   * The unit test drives the service with a map. This reads the real Redis the
   * real build wrote to: the key is under the prefix the API scans, the value
   * parses under the shared contract, and the build is the digest of the
   * BUILD_SHA this process was started with — the same digest
   * `verify:production` computes from the deployed commit. Then SIGTERM, and
   * the key must be gone: a stopped worker that lingers for the TTL is a
   * worker the verifier would report as alive on an old build for ninety
   * seconds after every upgrade.
   */
  const heartbeats = await readHeartbeats();
  if (heartbeats.length !== 1) {
    fail(`expected exactly one worker heartbeat in Redis, found ${heartbeats.length}`);
    return;
  }
  const [beat] = heartbeats;
  const expectedBuild = buildMarker(process.env['BUILD_SHA']);
  if (beat!.build !== expectedBuild) {
    fail(`the heartbeat says build ${beat!.build}; this process was started as ${expectedBuild}`);
    return;
  }
  if (beat!.role !== 'all' || beat!.queues.length === 0) {
    fail(
      `the heartbeat reports role ${beat!.role} with queues ${beat!.queues.join(',') || 'none'}`,
    );
    return;
  }
  console.log(`  ok  it wrote a heartbeat the API can read, on build ${beat!.build}`);

  worker.kill('SIGTERM');
  const gone = await waitUntil(async () => (await readHeartbeats()).length === 0, 10_000);
  if (!gone) {
    console.error(
      '  FAIL the heartbeat was still in Redis 10s after SIGTERM; a clean stop must withdraw it',
    );
    process.exitCode = 1;
    return;
  }
  console.log('  ok  a clean stop withdraws the heartbeat at once');

  /**
   * A narrowed processor (§77) takes only the queues it was given and writes
   * no schedules — so it can be scaled for the slow queue without every copy
   * also re-registering every cron. Proved on the real build, because the
   * assignment is decided in the registry's constructor and only this run
   * boots that.
   */
  const narrowed = await bootOnce(
    { WORKER_ROLE: 'processor', WORKER_QUEUES: 'webhook-delivery' },
    /Queue registry ready as processor: not scheduling; processing webhook-delivery/,
  );
  if (narrowed === null) {
    console.error('  FAIL a narrowed processor did not report the assignment it was given');
    process.exitCode = 1;
    return;
  }
  // The summary line says what was decided; the per-queue lines say what was
  // done. A processor attached to a queue it was not given would be invisible
  // to the first and caught by the second.
  const attached = [...narrowed.matchAll(/Processing ([a-z-]+)/g)].map((m) => m[1]);
  if (attached.join(',') !== 'webhook-delivery') {
    console.error(
      `  FAIL a narrowed processor attached to ${attached.join(', ') || 'nothing'}; expected webhook-delivery alone`,
    );
    process.exitCode = 1;
    return;
  }
  if (/Scheduled [a-z-]+:/.test(narrowed)) {
    console.error('  FAIL a processor registered a schedule; only all and scheduler roles may');
    console.error(narrowed.slice(-2000));
    process.exitCode = 1;
    return;
  }
  console.log('  ok  a narrowed processor takes only its queue and writes no schedules');

  const misnamed = await bootOnce({ WORKER_ROLE: 'processor', WORKER_QUEUES: 'webhooks' }, null);
  if (misnamed === null || !/nobody declared: webhooks/.test(misnamed)) {
    console.error('  FAIL a processor given an undeclared queue name did not refuse to start');
    if (misnamed !== null) console.error(misnamed.slice(-2000));
    process.exitCode = 1;
    return;
  }
  console.log('  ok  a queue name nobody declared is refused at boot, by name');

  /**
   * Secrets from files (docs/secrets.md): `DATABASE_URL_FILE` pointing at a
   * file holding the URL, and no `DATABASE_URL`, boots the real build; a
   * pointer at a missing file refuses to, naming the variable.
   */
  const secretDir = mkdtempSync(join(tmpdir(), 'tp-secret-'));
  const secretFile = join(secretDir, 'database_url');
  try {
    writeFileSync(secretFile, `${process.env['DATABASE_URL'] ?? ''}\n`, { mode: 0o600 });
    const fromFile = await bootOnce(
      { DATABASE_URL: '', DATABASE_URL_FILE: secretFile },
      /Worker started/,
    );
    if (fromFile === null || !/Secrets read from files: DATABASE_URL/.test(fromFile)) {
      console.error('  FAIL the worker did not boot from DATABASE_URL_FILE');
      if (fromFile !== null) console.error(fromFile.slice(-2000));
      process.exitCode = 1;
      return;
    }
    console.log('  ok  a secret delivered as a file is read at boot');

    const missing = await bootOnce(
      { DATABASE_URL: '', DATABASE_URL_FILE: join(secretDir, 'not-there') },
      null,
    );
    if (
      missing === null ||
      !/DATABASE_URL_FILE points at .*not-there, which could not be read/.test(missing)
    ) {
      console.error('  FAIL a secret file that is missing did not refuse boot by name');
      if (missing !== null) console.error(missing.slice(-2000));
      process.exitCode = 1;
      return;
    }
    console.log('  ok  a missing secret file refuses boot, naming the variable');
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }

  console.log('\nAll 9 worker smoke checks passed.');
}

/**
 * Boots the worker with extra environment and returns its output once `until`
 * has appeared (or, with `null`, once it has exited on its own). `null` means
 * neither happened inside the boot timeout.
 */
async function bootOnce(env: Record<string, string>, until: RegExp | null): Promise<string | null> {
  const child = spawn('node', [BUILD], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const output: string[] = [];
  let exited = false;
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.on('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  try {
    for (;;) {
      const text = output.join('');
      if (until !== null && until.test(text)) return text;
      if (exited) return until === null ? text : null;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    if (!exited) child.kill('SIGTERM');
  }
}

void main();

/**
 * The worker's own ioredis, because the harness has none of its own and the
 * point is to read what the worker's build wrote with the client it ships.
 */
async function readHeartbeats() {
  const require = createRequire(resolve('apps/worker/package.json'));
  const IORedis = (require('ioredis') as { default: new (url: string) => RedisLike }).default;
  const url = process.env['REDIS_URL'];
  if (url === undefined) throw new Error('REDIS_URL is required (from .env)');
  const redis = new IORedis(url);
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `${WORKER_HEARTBEAT_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length === 0) return [];
    const values = await redis.mget(...keys);
    return values.map(parseWorkerHeartbeat).filter((beat) => beat !== null);
  } finally {
    redis.disconnect();
  }
}

interface RedisLike {
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  disconnect(): void;
}

async function waitUntil(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return probe();
}
