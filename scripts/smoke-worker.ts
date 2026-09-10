import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

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

  worker.kill('SIGTERM');

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

  console.log('\nAll 5 worker smoke checks passed.');
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
