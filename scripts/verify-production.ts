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
  console.log(
    `  ${ok ? 'ok      ' : 'FAIL    '}${name}${detail === '' ? '' : `\n            ${detail}`}`,
  );
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
    record(
      'the build identifies itself',
      true,
      `build ${build} (pass --expect <sha> to confirm it)`,
    );
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
    Record<string, { status?: string; latencyMs?: number }> | undefined;
  record(
    'the database and Redis are reachable from the API',
    ready?.status === 200 &&
      info?.['database']?.status === 'up' &&
      info?.['redis']?.status === 'up',
    info === undefined
      ? `got ${ready?.status ?? 'no answer'}`
      : `database ${info['database']?.latencyMs ?? '?'}ms, redis ${info['redis']?.latencyMs ?? '?'}ms`,
  );

  /**
   * --- the work that happens without anybody asking ------------------------
   *
   * The only check here that can fail on a deployment where every other one
   * passes. A platform with a healthy API, a healthy database and no worker
   * registering schedules charges no overnight financing, runs no
   * reconciliation, purges no identity document at its retention limit, and
   * relays no event out of the outbox — and every probe above says it is fine,
   * because they all ask about things that answer when spoken to.
   */
  const jobs = await get('/health/jobs');
  const jobsBody = jobs === null ? null : json(jobs.body);
  const jobsInfo = (jobsBody?.['data'] as Record<string, unknown> | undefined) ?? jobsBody ?? {};
  /**
   * `details` carries every indicator whatever its status; `info` and `error`
   * split them by it. Read `details`, and fall back to the split for a build
   * that predates it being here — on a 503 the old filter dropped the report
   * altogether, so on those builds this is `{}` and every check below says so.
   */
  const indicators = (jobsInfo['details'] ?? jobsInfo['info'] ?? jobsInfo['error'] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const jobsDetail = indicators['scheduled-jobs'] as
    { status?: string; problems?: string[]; jobs?: number } | undefined;
  const problems = jobsDetail?.problems ?? [];

  if (jobs === null || (jobs.status !== 200 && jobs.status !== 503)) {
    record(
      'every scheduled job is still running on time',
      false,
      jobs?.status === 404
        ? 'got 404 from /health/jobs — either this deployment predates the probe, or the route is ' +
            'being served under the API prefix. Try /api/health/jobs before concluding it is old: ' +
            'that is what a missing entry in the global prefix exclusion list looks like, and it is ' +
            'how this probe spent its first week invisible.'
        : `got ${jobs?.status ?? 'no answer'} from /health/jobs — this deployment predates the probe`,
    );
  } else {
    /**
     * Judged on the schedule indicator's own status, not the response code:
     * `/health/jobs` also carries the worker indicator now, and a 503 for a
     * missing worker is not a late schedule. Each is its own line below.
     */
    record(
      'every scheduled job is still running on time',
      jobsDetail === undefined ? jobs.status === 200 : jobsDetail.status === 'up',
      problems.length === 0
        ? `${String(jobsDetail?.jobs ?? 0)} schedules, all inside their own tolerance`
        : problems.join('; '),
    );

    /**
     * And that the ones this deployment is supposed to have are *there*.
     *
     * The probe judges the rows it finds. A job that has never run once leaves
     * no row at all, so it is invisible to a check that only reads rows — and
     * "never ran" is precisely what a missing scheduler, or a backup container
     * that was never started, looks like. The expected set lives here rather
     * than in the platform because it is a fact about this deployment's shape:
     * a development machine with no backup container is not broken.
     *
     * Hand-written, and checked: `expected-schedules.test.ts` reads this list
     * and requires it to be exactly the worker's `SCHEDULED` table plus the
     * backup script's row name. A schedule added to the worker and forgotten
     * here would otherwise be one whose silence this check never asks about.
     */
    const named = Object.keys(indicators);
    const seen = (jobsDetail as unknown as { names?: string[] } | undefined)?.names ?? [];
    const EXPECTED = [
      'swap-accrual',
      'reconciliation',
      'idempotency-sweep',
      'broker-health',
      'outbox-relay',
      'webhook-delivery',
      'backup',
    ];
    const absent = EXPECTED.filter((name) => !seen.includes(name));
    record(
      'every schedule this deployment should have has run at least once',
      seen.length > 0 && absent.length === 0,
      seen.length === 0
        ? `/health/jobs did not name its schedules (probe present: ${named.join(', ') || 'none'})`
        : absent.length === 0
          ? `${String(seen.length)} present`
          : `never run: ${absent.join(', ')} — a schedule with no row has never fired once`,
    );

    /**
     * And that a worker is there *now*, on the build that was deployed.
     *
     * The schedule rows say what ran; a daily job's row is yesterday's worker's
     * for a day. The worker itself serves no HTTP and could not be asked, so
     * until it wrote a heartbeat it was the one container that could sit on
     * last week's image with nothing outside the host able to tell — which is
     * exactly what `api-ws` did for three upgrades before its handshake header
     * existed. Every heartbeat names its build; each is compared here.
     */
    const workers = indicators['workers'] as
      { instances?: Array<{ instance: string; build: string; ageMs?: number }> } | undefined;
    const instances = workers?.instances ?? [];
    if (workers === undefined) {
      record(
        'a worker is alive and says which build it runs',
        false,
        'no `workers` in /health/jobs — this deployment predates the worker heartbeat',
      );
    } else if (instances.length === 0) {
      record(
        'a worker is alive and says which build it runs',
        false,
        'no worker heartbeat — nothing will run the schedules, or the worker predates the heartbeat',
      );
    } else if (EXPECT === null) {
      record(
        'a worker is alive and says which build it runs',
        instances.every((one) => one.build !== 'unknown'),
        instances.map((one) => `${one.instance} on ${one.build}`).join(', ') +
          ' (pass --expect <sha> to confirm it)',
      );
    } else {
      const want = marker(EXPECT);
      const stale = instances.filter((one) => one.build !== want);
      record(
        'every worker runs the build that was deployed',
        stale.length === 0,
        stale.length === 0
          ? `${String(instances.length)} worker(s) on ${want}`
          : `on another build: ${stale.map((one) => `${one.instance} (${one.build})`).join(', ')} — ` +
              'the worker was not rebuilt or not recreated; compare its age to api in `docker ps`',
      );
    }
  }

  // --- the second isolation layer ------------------------------------------
  /**
   * The one safety property this deployment cannot be asked about any other
   * way. It was reported in a single boot log line and nowhere else, so on any
   * deployment older than a day the honest answer to "is row-level security
   * actually applying?" was that nobody could say.
   *
   * Not a pass/fail on `enforced` alone: the single-role deployment is a
   * documented posture and `.env.example` ships it. What fails is the pair the
   * platform promises to refuse — asked for and absent — and what is always
   * printed is which of the two this deployment is, so it is on the page rather
   * than in somebody's memory.
   */
  const tenancy = await get('/health/tenancy');
  const tenancyBody = tenancy === null ? null : json(tenancy.body);
  /**
   * Off `data`, like every other probe — the envelope wraps the report. This
   * read `info` off the top of the body from the day it was written, found
   * nothing there, printed "this deployment predates the probe" and passed:
   * a check that could not fail, on the one property this script exists to
   * ask about. `verify-production.test.ts` runs the script against a fake
   * deployment whose isolation is asked for and absent, and requires this
   * line to fail.
   */
  const tenancyReport = ((tenancyBody?.['data'] as Record<string, unknown> | undefined) ??
    tenancyBody ??
    {}) as Record<string, unknown>;
  const isolation = (tenancyReport['details'] ??
    tenancyReport['info'] ??
    tenancyReport['error'] ??
    {}) as Record<string, Record<string, unknown>>;
  const enforced = isolation['tenant-isolation']?.['enforced'];
  const configured = isolation['tenant-isolation']?.['configured'] === true;
  record(
    'tenant isolation is not both asked for and absent',
    tenancy !== null && !(configured && enforced === false),
    enforced === undefined
      ? `/health/tenancy answered ${tenancy?.status ?? 'nothing'} — this deployment predates the probe, ` +
          'or the route is under the API prefix (see the note on /health/jobs above)'
      : configured
        ? `DATABASE_URL_TENANT is set; row-level security enforced: ${String(enforced)}`
        : `single-role deployment (layer one only); row-level security enforced: ${String(enforced)}`,
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

  /**
   * And *which build* answered that handshake.
   *
   * The check above proves the real-time service is serving. It does not say
   * which version, and the version is a separate question here because it is a
   * separate container: nginx sends `/ws` to `api-ws` and everything else to
   * `api`, so the `/health` marker checked earlier is the HTTP instance's answer
   * only. On 21 September that answer matched the deployed commit while the
   * socket service was sixteen commits behind it — the upgrade script never
   * rebuilt or stopped it — and this script reported all sixteen checks passed.
   *
   * The gateway now puts the same marker on the handshake response as the
   * `x-tp-build` header (Engine.IO answers every request under `/ws` itself, so
   * a route could not carry it). Absent on a build older than the header; then
   * the answer is "predates the check", which is not a pass.
   */
  const wsBuild = handshake?.headers.get('x-tp-build') ?? null;
  if (wsBuild === null) {
    record(
      'the real-time service says which build it runs',
      false,
      'no x-tp-build header on the handshake — this real-time container predates the check, ' +
        'or was not rebuilt with the API. `docker ps` shows its age next to the api container.',
    );
  } else if (wsBuild === 'unknown') {
    record(
      'the real-time service says which build it runs',
      false,
      'the socket image was built without BUILD_SHA',
    );
  } else if (EXPECT === null) {
    record(
      'the real-time service says which build it runs',
      true,
      `build ${wsBuild} (pass --expect <sha> to confirm it)`,
    );
  } else {
    const want = marker(EXPECT);
    record(
      'the real-time service runs the build that was deployed',
      wsBuild === want,
      wsBuild === want
        ? `${wsBuild} matches ${EXPECT.slice(0, 12)}`
        : `socket service runs ${wsBuild}, expected ${want} — api-ws was not rebuilt or not recreated; ` +
            `compare its age to api in \`docker ps\``,
    );
  }

  // --- the screen a trader actually opens ----------------------------------
  const terminal = await get('/terminal');
  record(
    'the terminal is served',
    terminal !== null && (terminal.status === 200 || terminal.status === 308),
    `answered ${terminal?.status ?? 'nothing'}`,
  );

  /**
   * And which build served it. The fourth and last container: the API answers
   * in `/health`, the socket service on its handshake, the worker on its
   * heartbeat, and the web on every response as `x-tp-build`, folded into the
   * routes manifest at `next build` from the BUILD_SHA the image was built with.
   * A redirect carries no page headers, so the login page — which every visitor
   * can fetch and which is never redirected — is read when the terminal was.
   */
  const webPage = terminal !== null && terminal.status === 200 ? terminal : await get('/login');
  const webBuild = webPage?.headers.get('x-tp-build') ?? null;
  if (webBuild === null) {
    /**
     * Before blaming the container, ask the origin past whatever is in front
     * of it. The same page with a query string nobody has asked for before
     * cannot be answered from an edge cache, so it is the origin's answer.
     * On the first deploy of the header, production's origin served it on
     * every path while the public `/` and `/terminal` — the two pages a
     * trader opens — came back without it: something between the origin and
     * the visitor was answering those two paths from a copy older than the
     * deploy. That is a different fault from a stale container, and a worse
     * one: it means a deploy can leave traders on the previous page shell.
     */
    const path = webPage === terminal ? '/terminal' : '/login';
    const fresh = await get(`${path}?verify=${Date.now()}`);
    const originBuild = fresh?.headers.get('x-tp-build') ?? null;
    record(
      'the web says which build it runs',
      false,
      originBuild === null
        ? 'no x-tp-build header on the page — this web container predates the header, or was not rebuilt'
        : `the origin serves ${path} on build ${originBuild}, but the public ${path} carries no build header — ` +
            'something between the origin and the visitor (a CDN cache or rule) is answering for this path ' +
            'with a copy that predates the deploy. Purge it, and look at what caches HTML for this host.',
    );
  } else if (webBuild === 'unknown') {
    record('the web says which build it runs', false, 'the web image was built without BUILD_SHA');
  } else if (EXPECT === null) {
    record(
      'the web says which build it runs',
      true,
      `build ${webBuild} (pass --expect <sha> to confirm it)`,
    );
  } else {
    const want = marker(EXPECT);
    record(
      'the web runs the build that was deployed',
      webBuild === want,
      webBuild === want
        ? `${webBuild} matches ${EXPECT.slice(0, 12)}`
        : `the web serves ${webBuild}, expected ${want} — the web image was not rebuilt or the container not recreated`,
    );
  }

  /**
   * And that the origin forbids a shared cache from keeping the page shell.
   *
   * The root cause behind the stale edge above: Next marks prerendered pages
   * `s-maxage=31536000` for a CDN purged on every deploy, and nothing purges
   * this one. nginx now replaces that with `no-cache`. Asked of the origin —
   * with a query nobody has sent before — because the edge's copy of the plain
   * path may itself be the stale one, and is reported separately above.
   */
  const shellPath = terminal !== null && terminal.status === 200 ? '/terminal' : '/login';
  const shell = await get(`${shellPath}?verify=${Date.now() + 1}`);
  const cacheControl = shell?.headers.get('cache-control') ?? null;
  const forbidsShared =
    cacheControl !== null &&
    /\b(no-cache|no-store|private)\b/i.test(cacheControl) &&
    !/\bs-maxage=/i.test(cacheControl);
  record(
    'the page shell is not cacheable by a shared cache',
    forbidsShared,
    cacheControl === null
      ? `no Cache-Control on ${shellPath} — a shared cache may keep it as long as it likes`
      : forbidsShared
        ? `Cache-Control: ${cacheControl}`
        : `Cache-Control: ${cacheControl} — a shared cache may serve this shell after the next deploy, ` +
          'naming chunks the new image no longer has',
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
