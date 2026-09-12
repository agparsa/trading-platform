#!/usr/bin/env tsx
/**
 * Did the deploy land, and is production still what we think it is?
 *
 * ## Why this is HTTPS-only, on purpose
 *
 * Every existing check needs to be *inside* something: `smoke` boots the build
 * locally, the runbook's post-deploy steps read container logs over SSH. For a
 * whole weekend neither was possible — production sits behind Cloudflare, and
 * its origin takes no connection from anywhere the tooling runs. The only
 * honest answer to "did it deploy?" was to ask a person to go and look.
 *
 * So this asks only what any client can ask, over the public name, with no
 * credentials and no shell: the probes, the build marker, the shape of a
 * refusal, and whether the things that must *not* be public are in fact not
 * public. It runs from a laptop, from CI, or from a container on the other side
 * of the world, which is exactly the property that was missing.
 *
 * ## What it cannot tell you
 *
 * Said plainly. It sees one instance per request — whichever the edge routed
 * to — so a half-finished rollout where some containers are old can pass if the
 * request lands on a new one. It cannot read a log, count containers, or see
 * the worker at all, because none of that is exposed and none of it should be.
 * It is a deploy *check*, not a deploy *audit*: green here means the public
 * surface is right, and the container list still deserves a look.
 *
 *   pnpm verify:production
 *   pnpm verify:production --expect $(git rev-parse HEAD)
 *   PRODUCTION_URL=https://staging.example pnpm verify:production
 */
import { createHash } from 'node:crypto';

const BASE = (process.env['PRODUCTION_URL'] ?? 'https://devopss.ir').replace(/\/$/, '');
const EXPECT = expectedSha();

function expectedSha(): string | null {
  const flag = process.argv.indexOf('--expect');
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1] as string;
  const fromEnv = process.env['EXPECT_SHA'];
  return fromEnv === undefined || fromEnv === '' ? null : fromEnv;
}

/** The same derivation the API uses. Kept here rather than imported: this script must run against a deployment built from *another* commit. */
function marker(sha: string): string {
  return createHash('sha256').update(sha.trim()).digest('hex').slice(0, 12);
}

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: Result[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok      ' : 'FAIL    '}${name}${detail === '' ? '' : `\n            ${detail}`}`);
}

async function get(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: string; headers: Headers } | null> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      ...options,
    });
    return { status: response.status, body: await response.text(), headers: response.headers };
  } catch {
    return null;
  }
}

function json(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`\n  Verifying ${BASE} over HTTPS only — no credentials, no shell.\n`);

  // --- it is alive, and it is ours -----------------------------------------
  const health = await get('/health');
  if (health === null || health.status !== 200) {
    record('the API answers its liveness probe', false, `got ${health?.status ?? 'no answer'}`);
    return report();
  }
  const healthBody = json(health.body);
  const data = healthBody?.['data'] as Record<string, unknown> | undefined;
  record(
    'the API answers its liveness probe',
    healthBody?.['ok'] === true && data?.['status'] === 'ok',
    `up ${String(data?.['uptimeSeconds'] ?? '?')}s`,
  );

  /**
   * The envelope, not just the status code.
   *
   * A 200 from the edge with a body from something else — a parked page, a
   * cached error, another service on the same name — is the failure mode a
   * bare status check misses entirely.
   */
  record(
    'the answer is this platform, not something else on the name',
    healthBody !== null && 'ok' in healthBody && 'meta' in healthBody,
    'response carries the platform envelope (ok/meta)',
  );

  // --- which build --------------------------------------------------------
  const build = typeof data?.['build'] === 'string' ? (data['build'] as string) : null;
  if (build === null) {
    record(
      'the build identifies itself',
      false,
      'no `build` in /health — this deployment predates the build marker, so "what is running?" ' +
        'cannot be answered from outside. It appears once a build carries BUILD_SHA.',
    );
  } else if (build === 'unknown') {
    record(
      'the build identifies itself',
      false,
      'build is "unknown" — the image was built without BUILD_SHA. Deploy with ' +
        'BUILD_SHA=$(git rev-parse HEAD) so the next person can tell what is running.',
    );
  } else if (EXPECT === null) {
    record('the build identifies itself', true, `build ${build} (pass --expect <sha> to confirm it)`);
  } else {
    const want = marker(EXPECT);
    record(
      'the running build is the one that was deployed',
      build === want,
      build === want
        ? `${build} matches ${EXPECT.slice(0, 12)}`
        : `running ${build}, expected ${want} for ${EXPECT.slice(0, 12)} — the deploy did not land, ` +
          `or the old containers are still serving`,
    );
  }

  // --- it can serve ---------------------------------------------------------
  const ready = await get('/ready');
  const readyBody = ready === null ? null : json(ready.body);
  const info = (readyBody?.['data'] as Record<string, unknown> | undefined)?.['info'] as
    | Record<string, { status?: string; latencyMs?: number }>
    | undefined;
  record(
    'the database and Redis are reachable from the API',
    ready?.status === 200 && info?.['database']?.status === 'up' && info?.['redis']?.status === 'up',
    info === undefined
      ? `got ${ready?.status ?? 'no answer'}`
      : `database ${info['database']?.latencyMs ?? '?'}ms, redis ${info['redis']?.latencyMs ?? '?'}ms`,
  );

  // --- what must not be public ---------------------------------------------
  const metrics = await get('/metrics');
  record(
    'the metrics endpoint is not open to the internet',
    metrics !== null && metrics.status !== 200,
    `answered ${metrics?.status ?? 'nothing'} — a public /metrics leaks account counts and volumes`,
  );

  const docs = await get('/docs');
  const docsIsSwagger = docs !== null && docs.status === 200 && /swagger|openapi/i.test(docs.body);
  record(
    'the API reference is not served to anonymous callers',
    !docsIsSwagger,
    'Swagger is a development convenience; in production the route surface is not for whoever can reach the host',
  );

  const openapi = await get('/api/v1/developer/openapi.json');
  record(
    'the OpenAPI document requires a session',
    openapi !== null && openapi.status !== 200,
    `answered ${openapi?.status ?? 'nothing'}`,
  );

  // --- a refusal is a proper refusal ---------------------------------------
  const protectedRoute = await get('/api/v1/market/quotes');
  const refusal = protectedRoute === null ? null : json(protectedRoute.body);
  const error = refusal?.['error'] as Record<string, unknown> | undefined;
  record(
    'an unauthenticated call is refused with a coded error, not a crash',
    protectedRoute?.status === 401 && error?.['code'] === 'UNAUTHENTICATED',
    `${protectedRoute?.status ?? '?'} ${String(error?.['code'] ?? '')}`,
  );
  record(
    'every answer carries a request id, so a trader can be traced',
    typeof error?.['requestId'] === 'string' && (error['requestId'] as string).length > 0,
    'the id in an error response is what support asks for',
  );

  // --- the edge ------------------------------------------------------------
  const hsts = health.headers.get('strict-transport-security');
  record(
    'HSTS is set',
    hsts !== null && /max-age=\d{7,}/.test(hsts),
    hsts ?? 'absent — a downgrade to http would not be refused by the browser',
  );

  const nosniff = health.headers.get('x-content-type-options');
  record('X-Content-Type-Options is nosniff', nosniff === 'nosniff', nosniff ?? 'absent');

  /**
   * The socket the terminal lives on — asked the way a client asks.
   *
   * The first version of this sent `Connection: Upgrade` through `fetch`, which
   * silently drops forbidden headers, so the check reported "answered nothing"
   * against a socket server that was in perfect health. The Engine.IO
   * handshake is both correct and a stronger claim: a session id and an
   * `upgrades` list containing `websocket` prove the real-time transport is
   * actually serving, not merely that the path is routed somewhere.
   *
   * Worth the distinction because the failure this guards is quiet: when `/ws`
   * falls through to the SPA the page still loads, the badge still says
   * connected for a moment, and the only symptom is that prices stop moving.
   */
  const handshake = await get('/ws/socket.io/?EIO=4&transport=polling');
  const engineIo = handshake === null ? null : json(handshake.body.replace(/^\d+/, ''));
  record(
    'the real-time socket completes a handshake and offers a websocket upgrade',
    handshake?.status === 200 &&
      typeof engineIo?.['sid'] === 'string' &&
      Array.isArray(engineIo['upgrades']) &&
      (engineIo['upgrades'] as string[]).includes('websocket'),
    handshake === null
      ? 'no answer'
      : `${handshake.status} ${engineIo === null ? handshake.body.slice(0, 60) : `upgrades: ${String(engineIo['upgrades'])}`}`,
  );

  // --- the screen a trader actually opens ----------------------------------
  const terminal = await get('/terminal');
  record(
    'the terminal is served',
    terminal !== null && (terminal.status === 200 || terminal.status === 308),
    `answered ${terminal?.status ?? 'nothing'}`,
  );

  report();
}

function report(): void {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    console.log(
      `\n  All ${results.length} checks passed.\n` +
        `  This says the public surface is right. It does not say every container is\n` +
        `  on the new build — one request sees one instance. Look at the container\n` +
        `  list too, per runbook.md.\n`,
    );
    return;
  }
  console.error(`\n  ${failed.length} of ${results.length} checks failed:\n`);
  for (const result of failed) console.error(`    - ${result.name}`);
  console.error('');
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
