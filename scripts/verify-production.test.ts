import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `verify:production` is the last gate on every deploy, and it had no test of
 * its own. It was changed three times on 21 September, and one of the readers
 * it already had was wrong the whole time: the tenancy check read `info` off
 * the top of the body instead of off `data`, found nothing, printed "this
 * deployment predates the probe", and *passed* — on a deployment that had the
 * probe. The one safety property the script exists to ask about was a check
 * that could not fail.
 *
 * So the script is run, as a process, against a fake deployment: a local HTTP
 * server answering every path the script asks for with what a good deployment
 * answers. Then one answer at a time is made wrong, and the matching check —
 * and only it — must fail. A reader that cannot see a fault does not get to
 * call the deployment good.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = '54c7b29621323eadd2705c6cb86a0ef6ceaa4ff2';
const MARKER = createHash('sha256').update(SHA).digest('hex').slice(0, 12);

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}
type Deployment = Record<string, Answer>;

const envelope = (data: unknown) => JSON.stringify({ ok: true, data, meta: { requestId: 'r-1' } });
const edge = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
};
const SCHEDULES = [
  'swap-accrual',
  'reconciliation',
  'idempotency-sweep',
  'broker-health',
  'outbox-relay',
  'webhook-delivery',
  'backup',
];

/** What a healthy deployment on `SHA` answers. */
function good(): Deployment {
  const jobs = {
    status: 'ok',
    info: {},
    error: {},
    details: {
      'scheduled-jobs': { status: 'up', jobs: SCHEDULES.length, names: SCHEDULES, problems: [] },
      workers: {
        status: 'up',
        workers: 1,
        instances: [{ instance: 'host:1', build: MARKER, role: 'all', queues: ['swap-accrual'], ageMs: 5 }],
        builds: [MARKER],
      },
    },
  };
  return {
    '/health': {
      status: 200,
      headers: edge,
      body: envelope({ status: 'ok', uptimeSeconds: 5, build: MARKER }),
    },
    '/ready': {
      status: 200,
      body: envelope({
        status: 'ok',
        info: { database: { status: 'up', latencyMs: 3 }, redis: { status: 'up', latencyMs: 1 } },
        error: {},
        details: {},
      }),
    },
    '/health/jobs': { status: 200, body: envelope(jobs) },
    '/health/tenancy': {
      status: 200,
      body: envelope({
        status: 'ok',
        info: { 'tenant-isolation': { enforced: true, configured: true, status: 'up' } },
        error: {},
        details: { 'tenant-isolation': { enforced: true, configured: true, status: 'up' } },
      }),
    },
    '/metrics': { status: 403, body: 'forbidden' },
    '/docs': { status: 404, body: 'not found' },
    '/api/v1/developer/openapi.json': { status: 401, body: '{}' },
    '/api/v1/market/quotes': {
      status: 401,
      body: JSON.stringify({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r-2' } }),
    },
    '/ws/socket.io/': {
      status: 200,
      headers: { 'x-tp-build': MARKER },
      body: '0{"sid":"abc","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
    },
    '/terminal': {
      status: 200,
      headers: { 'x-tp-build': MARKER, 'cache-control': 'no-cache' },
      body: '<html>terminal</html>',
    },
    '/login': {
      status: 200,
      headers: { 'x-tp-build': MARKER, 'cache-control': 'no-cache' },
      body: '<html>login</html>',
    },
  };
}

/** Runs the script against `deployment` and returns each check's name and outcome. */
async function verify(
  deployment: Deployment,
  expect: string | null = SHA,
): Promise<{ ok: string[]; failed: string[]; output: string; status: number | null }> {
  const server: Server = createServer((request, response) => {
    const [path, query] = (request.url ?? '/').split('?') as [string, string | undefined];
    // `'/x?'` answers a request for /x that carries any query string, when a
    // scenario wants the cache-busted fetch answered differently from the plain one.
    const answer =
      (query !== undefined ? deployment[`${path}?`] : undefined) ??
      deployment[path] ??
      { status: 404, body: 'no such path in the fake deployment' };
    response.writeHead(answer.status, { 'content-type': 'text/plain', ...(answer.headers ?? {}) });
    response.end(answer.body ?? '');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    // Asynchronously, and this is not a style choice: the fake deployment is
    // served by this very process, and a synchronous spawn would block the
    // event loop the server needs. The first version did that, every request
    // hung for the script's twenty-second timeout, and every check "failed".
    const result = await new Promise<{ status: number | null; output: string }>((done) => {
      const child = spawn(
        'npx',
        ['tsx', 'scripts/verify-production.ts', ...(expect === null ? [] : ['--expect', expect])],
        {
          cwd: ROOT,
          env: { ...process.env, PRODUCTION_URL: `http://127.0.0.1:${port}`, EXPECT_SHA: '' },
        },
      );
      const chunks: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      child.on('close', (status) => done({ status, output: chunks.join('') }));
    });
    const lines = result.output.split('\n');
    return {
      ok: lines.filter((line) => /^ {2}ok {6}/.test(line)).map((line) => line.replace(/^ {2}ok {6}/, '')),
      failed: lines.filter((line) => /^ {2}FAIL {4}/.test(line)).map((line) => line.replace(/^ {2}FAIL {4}/, '')),
      output: result.output,
      status: result.status,
    };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('verify-production, run against a fake deployment', () => {
  let healthy: Awaited<ReturnType<typeof verify>>;
  beforeAll(async () => {
    healthy = await verify(good());
  }, 90_000);

  it('passes every check on a healthy deployment, and says how many', () => {
    expect(healthy.failed, healthy.output).toEqual([]);
    expect(healthy.ok.length).toBeGreaterThanOrEqual(20);
    expect(healthy.output).toMatch(new RegExp(`All ${healthy.ok.length} checks passed`));
    expect(healthy.status).toBe(0);
  });

  it('confirms the build on every container, not merely that each answers', () => {
    expect(healthy.ok).toContain('the running build is the one that was deployed');
    expect(healthy.ok).toContain('the real-time service runs the build that was deployed');
    expect(healthy.ok).toContain('every worker runs the build that was deployed');
    expect(healthy.ok).toContain('the web runs the build that was deployed');
  });

  /**
   * The finding this file was written for. `configured: true, enforced: false`
   * is the pair the platform promises to refuse, and the reader that looked in
   * the wrong place reported "predates the probe" and passed.
   */
  it('fails when isolation was asked for and is absent', async () => {
    const deployment = good();
    deployment['/health/tenancy'] = {
      status: 200,
      body: envelope({
        status: 'ok',
        info: { 'tenant-isolation': { enforced: false, configured: true, status: 'up' } },
        error: {},
        details: { 'tenant-isolation': { enforced: false, configured: true, status: 'up' } },
      }),
    };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['tenant isolation is not both asked for and absent']);
    expect(run.output).not.toContain('predates the probe');
  }, 60_000);

  it('says which posture a deployment has, rather than that it cannot tell', () => {
    expect(healthy.output).toContain('DATABASE_URL_TENANT is set; row-level security enforced: true');
    expect(healthy.output).not.toContain('predates the probe');
  });

  it('fails the worker check alone when a worker is on another build', async () => {
    const deployment = good();
    const jobs = JSON.parse(deployment['/health/jobs']!.body!) as { data: { details: Record<string, unknown> } };
    (jobs.data.details['workers'] as { instances: Array<{ build: string }> }).instances[0]!.build = 'aaaaaaaaaaaa';
    deployment['/health/jobs'] = { status: 200, body: JSON.stringify(jobs) };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['every worker runs the build that was deployed']);
    expect(run.output).toContain('host:1 (aaaaaaaaaaaa)');
  }, 60_000);

  it('reads a 503 report from the failure envelope and names the late schedule', async () => {
    const deployment = good();
    const report = {
      status: 'error',
      info: {
        workers: (JSON.parse(deployment['/health/jobs']!.body!) as { data: { details: Record<string, unknown> } })
          .data.details['workers'],
      },
      error: {
        'scheduled-jobs': {
          status: 'down',
          jobs: SCHEDULES.length,
          names: SCHEDULES,
          problems: ['swap-accrual last succeeded 3 days ago; its cron allows 1 day'],
        },
      },
      details: {},
    };
    (report.details as Record<string, unknown>)['scheduled-jobs'] = report.error['scheduled-jobs'];
    (report.details as Record<string, unknown>)['workers'] = report.info.workers;
    deployment['/health/jobs'] = {
      status: 503,
      body: JSON.stringify({
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable Exception', requestId: 'r-3' },
        data: report,
      }),
    };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['every scheduled job is still running on time']);
    expect(run.output).toContain('swap-accrual last succeeded 3 days ago');
    // The worker is fine and is not blamed for the schedule.
    expect(run.ok).toContain('every worker runs the build that was deployed');
  }, 60_000);

  it('fails the socket build check when the handshake carries no header', async () => {
    const deployment = good();
    deployment['/ws/socket.io/'] = { ...deployment['/ws/socket.io/']!, headers: {} };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['the real-time service says which build it runs']);
    expect(run.ok).toContain('the real-time socket completes a handshake and offers a websocket upgrade');
  }, 60_000);

  it('reads the web build from the login page when the terminal redirects', async () => {
    const deployment = good();
    deployment['/terminal'] = { status: 308, headers: { location: '/login' } };
    const run = await verify(deployment);
    expect(run.failed).toEqual([]);
    deployment['/login'] = {
      ...deployment['/login']!,
      headers: { 'x-tp-build': 'bbbbbbbbbbbb', 'cache-control': 'no-cache' },
    };
    const stale = await verify(deployment);
    expect(stale.failed).toEqual(['the web runs the build that was deployed']);
  }, 90_000);

  /**
   * The edge and the origin can disagree, and did: on the first deploy of the
   * web header, the origin served it on every path and the public `/terminal`
   * did not. The fake here answers the plain path like that edge and the
   * cache-busted path like the origin; the check must fail and must say which
   * of the two is at fault.
   */
  it('tells a stale edge copy apart from a stale container', async () => {
    const deployment = good();
    deployment['/terminal'] = { status: 200, headers: { 'cache-control': 'no-cache' }, body: '<html>terminal</html>' }; // no build header: the edge's copy
    deployment['/terminal?'] = {
      status: 200,
      headers: { 'x-tp-build': MARKER, 'cache-control': 'no-cache' },
      body: '<html>terminal</html>',
    };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['the web says which build it runs']);
    expect(run.output).toContain(`the origin serves /terminal on build ${MARKER}`);
    expect(run.output).toContain('something between the origin and the visitor');
  }, 60_000);

  it('blames the container when the origin has no header either', async () => {
    const deployment = good();
    deployment['/terminal'] = { status: 200, headers: { 'cache-control': 'no-cache' }, body: '<html>terminal</html>' };
    deployment['/login'] = { status: 200, headers: { 'cache-control': 'no-cache' }, body: '<html>login</html>' };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['the web says which build it runs']);
    expect(run.output).toContain('predates the header, or was not rebuilt');
  }, 60_000);

  it("fails when the origin still sends Next's year-long s-maxage on the page shell", async () => {
    const deployment = good();
    deployment['/terminal'] = {
      status: 200,
      headers: { 'x-tp-build': MARKER, 'cache-control': 's-maxage=31536000' },
      body: '<html>terminal</html>',
    };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['the page shell is not cacheable by a shared cache']);
    expect(run.output).toContain('s-maxage=31536000');
  }, 60_000);

  it('fails, and says so with the expected marker, when the API runs another build', async () => {
    const deployment = good();
    deployment['/health'] = {
      ...deployment['/health']!,
      body: envelope({ status: 'ok', uptimeSeconds: 5, build: 'cccccccccccc' }),
    };
    const run = await verify(deployment);
    expect(run.failed).toEqual(['the running build is the one that was deployed']);
    expect(run.output).toContain(`expected ${MARKER}`);
    expect(run.status).not.toBe(0);
  }, 60_000);
});
