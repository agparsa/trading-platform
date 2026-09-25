import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The deployment artefacts, checked the way nothing else checks them.
 *
 * Dockerfiles, `docker-compose.prod.yml` and `.dockerignore` are not TypeScript.
 * Typecheck does not read them, lint does not read them, and no test did either
 * — so the first time anybody found out whether they were right was on a host,
 * at the least convenient moment.
 *
 * This file exists because that gap produced a real failure: `web.Dockerfile`
 * copied `apps/web/public`, which did not exist, and `COPY` of a missing path is
 * a build error. The web image could not be built at all, and nothing in a green
 * `pnpm verify` had any way to say so.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/**
 * One service's block out of a compose file, by name.
 *
 * The same two-space split the rest of this file uses, given a name so that a
 * test asking about one service cannot accidentally match a neighbour's lines:
 * `ulimits` under `api` and `ulimits` under `nginx` are the same eight
 * characters, and a whole-file regex would be satisfied by either.
 */
const serviceBlock = (compose: string, service: string): string | null =>
  compose.split(/\n {2}(?=[a-z])/).find((block) => block.trim().startsWith(`${service}:`)) ?? null;

const DOCKERFILES = readdirSync(resolve(ROOT, 'docker'))
  .filter((name) => name.endsWith('.Dockerfile'))
  .map((name) => `docker/${name}`);

/**
 * The images that run this platform's own code. Nginx is deliberately not one
 * of them: its master process binds 80 and 443 and so starts as root, dropping
 * its workers — the processes that actually handle a request — to `nginx`. That
 * is the stock image's design and the ports are the reason. Every image running
 * code written here has no such excuse.
 */
const APPLICATION_DOCKERFILES = DOCKERFILES.filter((file) => !file.includes('nginx'));

/**
 * Everything a `COPY` reads, resolved back to a path in this repository.
 *
 * Two kinds, and the second is the one that matters. A plain `COPY src dest`
 * reads from the build context, so `src` is a repo path directly. A
 * `COPY --from=build /app/x dest` reads from an earlier stage — but every stage
 * in these files is built from this context with `WORKDIR /app`, so `/app/x` is
 * a repo path too, unless the build itself produced it.
 *
 * Skipping `--from=` lines is the obvious reading and it is wrong: the missing
 * `apps/web/public` that could not be built was on a `--from=build` line. It
 * existed in that stage only because the context had it, and the context did
 * not.
 */
const BUILD_PRODUCED = ['dist', '.next', 'node_modules'];

function copySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const raw of read(dockerfile).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('COPY ')) continue;
    const operands = line
      .slice(5)
      .split(/\s+/)
      .filter((part) => !part.startsWith('--'));
    // The last operand is the destination.
    for (const operand of operands.slice(0, -1)) {
      // `pnpm-lock.yaml*` and friends are deliberately optional.
      if (operand.includes('*')) continue;
      if (!operand.startsWith('/')) {
        sources.push(operand);
        continue;
      }
      // A stage path. Anything outside the workspace root is that image's own
      // filesystem and none of this repository's business.
      if (!operand.startsWith('/app/')) continue;
      const relative = operand.slice('/app/'.length);
      // Produced by an earlier stage rather than copied into it.
      if (BUILD_PRODUCED.some((part) => relative.split('/').includes(part))) continue;
      sources.push(relative);
    }
  }
  return sources;
}

describe('Dockerfiles', () => {
  it('finds every file they copy, from the context or from an earlier stage', () => {
    const missing: string[] = [];
    for (const dockerfile of DOCKERFILES) {
      for (const source of copySources(dockerfile)) {
        if (!existsSync(resolve(ROOT, source))) missing.push(`${dockerfile}: ${source}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('copies at least something, so an empty parse cannot pass this file', () => {
    // Guards the test itself: a regex that matched nothing would make the check
    // above vacuously green, which is worse than not having it.
    expect(DOCKERFILES.length).toBeGreaterThanOrEqual(4);
    for (const dockerfile of DOCKERFILES) {
      expect(copySources(dockerfile).length).toBeGreaterThan(0);
    }
  });

  it('runs every application service as a user that is not root', () => {
    expect(APPLICATION_DOCKERFILES.length).toBeGreaterThanOrEqual(3);
    for (const dockerfile of APPLICATION_DOCKERFILES) {
      expect(read(dockerfile)).toMatch(/^USER\s+node\s*$/m);
    }
  });

  /**
   * A healthcheck that queries the database turns a brief database blip into an
   * orchestrator killing every healthy replica at once, which is the last thing
   * anybody needs during a database incident. Liveness only.
   */
  it('keeps healthchecks off the database', () => {
    for (const dockerfile of DOCKERFILES) {
      const body = read(dockerfile);
      if (!body.includes('HEALTHCHECK')) continue;
      expect(body).not.toMatch(/HEALTHCHECK[\s\S]{0,400}?\/ready/);
    }
  });
});

describe('.dockerignore', () => {
  const ignored = read('.dockerignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  /**
   * Without this the context carries several gigabytes of `node_modules`,
   * including native binaries built for whoever ran the command, and the
   * Dockerfiles copy `packages/` — binaries and all — before `pnpm install` can
   * fetch the right ones.
   */
  it('keeps node_modules and build output out of the context', () => {
    for (const pattern of ['node_modules', '**/node_modules', '.next', 'dist']) {
      expect(ignored).toContain(pattern);
    }
  });

  it('keeps every real env file out of the context', () => {
    expect(ignored).toContain('.env');
    expect(ignored).toContain('.env.*');
    // …and does not then let one back in. A secret in a layer stays in it.
    expect(ignored.filter((line) => line.startsWith('!.env'))).toEqual([]);
  });
});

describe('docker-compose.prod.yml', () => {
  const compose = read('docker-compose.prod.yml');

  /**
   * Descriptor ceilings, which nothing declared and nobody would have looked
   * for until it bit.
   *
   * Measured on production: the nginx container's `ulimit -n` was **1024**,
   * Docker's default, while `nginx.conf` asked for 4096 connections per worker
   * across two workers. nginx says so at startup —
   *
   * ```text
   * nginx: [warn] 4096 worker_connections exceed open file resource limit: 1024
   * ```
   *
   * — once, into a log that scrolls away, and then serves happily until the day
   * it runs out. A reverse-proxied connection costs two descriptors, so the
   * real ceiling was about five hundred per worker rather than four thousand.
   *
   * `api-ws` had 1024 too, and holding many concurrent sockets is the whole of
   * that container's job. `capacity.md` documents a **thousand-socket** run:
   * nginx would need ~2,000 descriptors for it and `api-ws` ~1,000, so the
   * documented figure was not reachable on this deployment — and the failure
   * would have arrived as EMFILE, looking like the platform breaking rather
   * than like a limit nobody set.
   */
  const CONNECTION_BEARING = ['nginx', 'api', 'api-ws', 'api-ingest', 'worker'] as const;

  const nofileOf = (service: string): number | null => {
    const block = serviceBlock(compose, service);
    const soft = /ulimits:\s*\n\s*nofile:\s*\n\s*soft:\s*(\d+)/.exec(block ?? '');
    return soft?.[1] === undefined ? null : Number(soft[1]);
  };

  it('gives every connection-bearing service a descriptor ceiling of its own', () => {
    const missing = CONNECTION_BEARING.filter((service) => nofileOf(service) === null);
    expect(missing, 'these hold connections and would inherit Docker’s default of 1024').toEqual(
      [],
    );
  });

  /**
   * And that the ceiling is above what nginx is configured to use. Two
   * descriptors per proxied connection, and `worker_processes auto` means one
   * worker per core — so the figure that has to fit is per worker, which is
   * what `worker_rlimit_nofile` governs.
   */
  it('lets nginx open what its own configuration asks for', () => {
    const conf = read('docker/nginx/nginx.conf');
    const connections = Number(/worker_connections\s+(\d+)/.exec(conf)?.[1] ?? 0);
    const rlimit = Number(/worker_rlimit_nofile\s+(\d+)/.exec(conf)?.[1] ?? 0);
    const container = nofileOf('nginx') ?? 0;

    expect(connections, 'worker_connections not found').toBeGreaterThan(0);
    expect(rlimit, 'nginx does not raise its own descriptor limit').toBeGreaterThan(0);
    // Two per proxied connection: one downstream, one upstream.
    expect(rlimit, 'nginx asks for more connections than it can open').toBeGreaterThanOrEqual(
      connections * 2,
    );
    // And the container has to allow what nginx asks for.
    expect(container, 'the container caps nginx below its own limit').toBeGreaterThanOrEqual(
      rlimit,
    );
  });

  /**
   * The socket target `capacity.md` documents has to fit through both layers.
   * Read from the document rather than hard-coded, so raising the claim without
   * raising the ceilings fails here.
   *
   * The counts have to be read as the document writes them, which is mostly in
   * words. A digits-only reader finds `200 sockets` in three table rows and
   * nothing else, and reports a target of two hundred while the document's
   * headline result is *five thousand* — a guard that passes with a ceiling a
   * twenty-fifth of the size it is supposed to be checking. That is how this
   * test read until it was run against the document rather than against the
   * three numbers it was written beside.
   */
  const WORD_VALUE: Record<string, number> = {
    a: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

  /** `five thousand` → 5000, `thirteen hundred` → 1300, `1,024` → 1024. */
  const countBefore = (phrase: string): number | null => {
    const digits = /([\d][\d,]*)\s*$/.exec(phrase);
    if (digits) return Number(digits[1]!.replace(/,/g, ''));
    const words = phrase
      .toLowerCase()
      .trim()
      .split(/[\s-]+/)
      .slice(-3);
    let total = 0;
    let current = 0;
    let saw = false;
    for (const word of words) {
      if (WORD_VALUE[word] !== undefined) {
        current = WORD_VALUE[word]!;
        saw = true;
      } else if (SCALE[word] !== undefined && saw) {
        current *= SCALE[word]!;
        total += current;
        current = 0;
      } else {
        total = 0;
        current = 0;
        saw = false;
      }
    }
    const value = total + current;
    return saw && value > 0 ? value : null;
  };

  it('has room for the socket count capacity.md claims', () => {
    const capacity = read('docs/capacity.md');
    const claimed = [...capacity.matchAll(/([^.\n]{0,40}?)\s*sockets\b/g)]
      .map((match) => countBefore(match[1] ?? ''))
      .filter((count): count is number => count !== null);
    expect(claimed.length, 'no socket figure found in capacity.md').toBeGreaterThan(0);
    // Written in words, so a digits-only reader would have found only the
    // three `200 sockets` table rows.
    expect(Math.max(...claimed), 'the headline figure is not being read').toBeGreaterThan(200);

    const target = Math.max(...claimed);
    // nginx: two descriptors per socket. api-ws: one.
    expect(
      nofileOf('nginx') ?? 0,
      `${target} sockets need ${target * 2} at nginx`,
    ).toBeGreaterThanOrEqual(target * 2);
    expect(
      nofileOf('api-ws') ?? 0,
      `${target} sockets need ${target} at api-ws`,
    ).toBeGreaterThanOrEqual(target);
  });

  /**
   * Two processes ingesting the same feed double-count candle volume; two firing
   * stops race each other for the same rows. Exactly one instance does both, and
   * it is the one that serves nobody.
   */
  it('turns ingest and the trigger engine on for exactly one service, and off for every other API service', () => {
    expect(compose.match(/MARKET_INGEST_ENABLED: 'true'/g)).toHaveLength(1);
    expect(compose.match(/TRIGGER_ENGINE_ENABLED: 'true'/g)).toHaveLength(1);
    const apiServices = compose
      .split(/\n {2}(?=[a-z])/)
      .filter(
        (block) =>
          /dockerfile: docker\/api\.Dockerfile/.test(block) &&
          /restart: unless-stopped/.test(block),
      );
    expect(apiServices.length).toBeGreaterThanOrEqual(3);
    expect(compose.match(/MARKET_INGEST_ENABLED: 'false'/g)).toHaveLength(apiServices.length - 1);
    expect(compose.match(/TRIGGER_ENGINE_ENABLED: 'false'/g)).toHaveLength(apiServices.length - 1);
  });

  /**
   * §77: the WebSocket is served by its own containers. Nginx sends `/ws` to
   * `api-ws` and everything else to `api`; both run the API image with the
   * same flags, and only the route decides what each does.
   */
  it('serves the WebSocket from its own containers', () => {
    const nginx = read('docker/nginx/nginx.conf');
    expect(nginx).toMatch(/location \/ws \{[\s\S]*?set \$api_ws api-ws:4000;/);
    expect(nginx.match(/set \$api api:4000;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const services = compose.split(/\n {2}(?=[a-z])/);
    const ws = services.find((block) => block.trim().startsWith('api-ws:'));
    expect(ws, 'api-ws service exists').toBeDefined();
    expect(ws).toMatch(/dockerfile: docker\/api\.Dockerfile/);
    expect(ws).toMatch(/MARKET_INGEST_ENABLED: 'false'/);
    expect(ws).toMatch(/stop_grace_period: 40s/);
  });

  it('publishes ports from nginx and from nothing else', () => {
    const services = compose.split(/\n {2}(?=[a-z])/);
    const publishing = services
      .filter((block) => /\n\s+ports:/.test(block))
      .map((block) => block.trim().split(':')[0]);
    expect(publishing).toEqual(['nginx']);
  });

  /**
   * Compose interpolates the whole file it is given, profiles included, so a
   * required variable anywhere in it stops every `up`, `ps` and `logs` on a
   * host that has not set it. Grafana's password is required — and therefore
   * lives in a file that is only read when Grafana is wanted.
   */
  it('requires nothing an ordinary deploy does not set', () => {
    const required = [...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]!);
    expect(required).not.toContain('GRAFANA_ADMIN_PASSWORD');
    expect(compose).not.toMatch(/grafana|prometheus/i);
  });

  it('runs migrations as a job everything else waits for', () => {
    expect(compose).toMatch(/command: \['npx', 'prisma', 'migrate', 'deploy'\]/);
    expect(
      compose.match(/migrate: \{ condition: service_completed_successfully \}/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it('mounts no source directory over the code that was built', () => {
    // A bind mount over apps/ in production runs code nobody built or tested.
    expect(compose).not.toMatch(/- \.\/apps/);
    expect(compose).not.toMatch(/- \.\/packages/);
  });

  /**
   * The API drains for up to SHUTDOWN_DRAIN_TIMEOUT_MS (default 25 s) before it
   * closes. Docker's default grace period is 10 s, which would SIGKILL it with
   * requests still inside. Every service that runs the API or the worker states
   * a grace period longer than the drain.
   */
  it('gives every application process longer to stop than it takes to drain', () => {
    const services = compose.split(/\n {2}(?=[a-z])/);
    // The migrate job shares the API image but runs `prisma migrate deploy`
    // once and exits; it is not a long-running process anybody drains.
    const appServices = services.filter(
      (block) =>
        /dockerfile: docker\/(api|worker)\.Dockerfile/.test(block) &&
        /restart: unless-stopped/.test(block),
    );
    expect(appServices.length).toBeGreaterThanOrEqual(3);
    const drainDefaultMs = 25_000;
    for (const block of appServices) {
      const grace = /stop_grace_period: (\d+)s/.exec(block);
      expect(grace, `${block.trim().split(':')[0]} states stop_grace_period`).not.toBeNull();
      expect(Number(grace![1]) * 1000).toBeGreaterThan(drainDefaultMs);
    }
  });
});

// ─── The one container that decides whether anybody can reach the platform ───

describe('the web container binds an address its healthcheck can reach', () => {
  /**
   * Next's standalone server binds whatever `HOSTNAME` says, and Docker sets
   * that variable to the container id — so without an override it binds the
   * container's own address, the Dockerfile's `fetch('http://127.0.0.1:3000/')`
   * is refused, and the container reports unhealthy while serving every request
   * correctly. It ran that way in production for a day.
   */
  it('sets HOSTNAME to 0.0.0.0 for the web service', () => {
    const compose = read('docker-compose.prod.yml');
    const web = compose.slice(compose.indexOf('\n  web:'), compose.indexOf('\n  nginx:'));
    expect(web).toMatch(/HOSTNAME: '0\.0\.0\.0'/);
  });

  it('still healthchecks over loopback, which is the point of the override', () => {
    expect(read('docker/web.Dockerfile')).toContain('http://127.0.0.1:3000/');
  });
});

describe('nginx', () => {
  const conf = read('docker/nginx/nginx.conf');

  /**
   * `ssl_certificate` is not conditional and a missing file stops Nginx from
   * starting. Pointing it straight at the operator's mount meant a first bring-up
   * on a host with no certificate yet started Postgres, Redis, the API, the
   * worker and the web app, and then failed on the only container anybody could
   * have reached them through.
   */
  it('serves the certificate the entrypoint resolved, not the raw mount', () => {
    expect(conf).toMatch(/ssl_certificate\s+\/etc\/nginx\/active-certs\/fullchain\.pem;/);
    expect(conf).toMatch(/ssl_certificate_key\s+\/etc\/nginx\/active-certs\/privkey\.pem;/);
    expect(conf).not.toMatch(/ssl_certificate(_key)?\s+\/etc\/nginx\/certs\//);
  });

  it('answers its own health check without asking anything upstream', () => {
    expect(conf).toMatch(/location = \/nginx-health/);
  });

  it('ships openssl in the image, because the stock alpine image has none', () => {
    expect(read('docker/nginx.Dockerfile')).toMatch(/apk add --no-cache openssl/);
  });

  /**
   * Every `location { ... }` block in the file, by brace depth, with the
   * server block's listen line so the 443 ones can be told from the 80 ones.
   */
  const locations = (): Array<{ header: string; body: string; listen: string }> => {
    const found: Array<{ header: string; body: string; listen: string }> = [];
    let listen = '';
    const re = /listen\s+(\d+)[^;]*;|location\s+([^{]+)\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(conf)) !== null) {
      if (match[1] !== undefined) {
        listen = match[1];
        continue;
      }
      let depth = 1;
      let i = re.lastIndex;
      for (; i < conf.length && depth > 0; i += 1) {
        if (conf[i] === '{') depth += 1;
        else if (conf[i] === '}') depth -= 1;
      }
      found.push({ header: match[2]!.trim(), body: conf.slice(re.lastIndex, i - 1), listen });
      re.lastIndex = i;
    }
    return found;
  };

  /**
   * The page shell must never be cacheable by a shared cache.
   *
   * Next marks every prerendered page `s-maxage=31536000`, for a CDN that is
   * purged on each deploy. This one is not, and on 21 September the CDN in
   * front of production answered `/` and `/terminal` with the shell from before
   * the day's deploys, `/login` with the previous deploy's, and the origin the
   * current one — three builds at once. A stale shell names chunks the new
   * image no longer has, and the trader's next click is a client-side
   * exception. Next's own `headers()` cannot override Cache-Control, so the
   * edge does, and the hashed assets — which *are* immutable — are routed past
   * that block untouched.
   */
  describe('the page shell is not cacheable by a shared cache', () => {
    const web = () => locations().find((one) => one.header === '/' && one.listen === '443');
    const assets = () => locations().find((one) => one.header === '^~ /_next/static/');

    it('replaces what Next says with no-cache, on every response', () => {
      const block = web();
      expect(block, 'the 443 location / exists').toBeDefined();
      expect(block!.body).toMatch(/proxy_hide_header\s+Cache-Control;/);
      expect(block!.body).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s+always;/);
    });

    it('lets the hashed assets keep their immutable caching, by matching them first', () => {
      const block = assets();
      expect(block, 'a prefix-priority location for /_next/static/ exists').toBeDefined();
      expect(block!.listen).toBe('443');
      expect(block!.body).not.toMatch(/Cache-Control/);
      expect(block!.body).toMatch(/proxy_pass\s+http:\/\/\$web;/);
    });
  });

  /**
   * Nginx's `add_header` is inherited from the server block only into locations
   * that add none of their own. A location that adds one header therefore
   * silently drops HSTS for every response it serves — the header this file
   * exists to set. So: any 443 location that uses `add_header` repeats it.
   */
  it('repeats HSTS in every 443 location that adds a header of its own', () => {
    const offenders = locations()
      .filter((one) => one.listen === '443' && /add_header/.test(one.body))
      .filter(
        (one) =>
          !/add_header\s+Strict-Transport-Security\s+"max-age=31536000; includeSubDomains"\s+always;/.test(
            one.body,
          ),
      )
      .map((one) => one.header);
    expect(offenders).toEqual([]);
    // And the probe that cannot fail: the walk found the location that motivated this.
    expect(locations().some((one) => one.listen === '443' && /add_header/.test(one.body))).toBe(
      true,
    );
  });
});

describe('the certificate entrypoint', () => {
  const script = resolve(ROOT, 'docker/nginx/entrypoint/10-resolve-certificates.sh');

  const runIn = (dir: string) => {
    const mounted = resolve(dir, 'mounted');
    const active = resolve(dir, 'active');
    mkdirSync(mounted, { recursive: true });
    const result = spawnSync('sh', [script], {
      env: { ...process.env, TP_CERT_MOUNT: mounted, TP_CERT_ACTIVE: active },
      encoding: 'utf8',
    });
    return { ...result, mounted, active };
  };

  const temp = () => mkdtempSync(resolve(tmpdir(), 'tp-certs-'));

  it('generates a usable certificate when nothing is mounted, and says so', () => {
    const dir = temp();
    try {
      const run = runIn(dir);
      expect(run.status).toBe(0);
      expect(existsSync(resolve(run.active, 'fullchain.pem'))).toBe(true);
      expect(existsSync(resolve(run.active, 'privkey.pem'))).toBe(true);
      // A warning nobody can miss, on stderr, every boot.
      expect(run.stderr).toContain('NO CERTIFICATE FOR');
      // And it is a certificate, not an empty file.
      const shown = spawnSync(
        'openssl',
        ['x509', '-in', resolve(run.active, 'fullchain.pem'), '-noout', '-subject'],
        { encoding: 'utf8' },
      );
      expect(shown.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The half that matters more. A real certificate is mounted and must be the
   * one served — an entrypoint that quietly preferred its own self-signed copy
   * would take a correctly provisioned host and make it warn every visitor.
   */
  it('uses the mounted certificate when there is one, and warns about nothing', () => {
    const dir = temp();
    try {
      const mounted = resolve(dir, 'mounted');
      mkdirSync(mounted, { recursive: true });
      const made = spawnSync('openssl', [
        'req',
        '-x509',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-days',
        '1',
        '-keyout',
        resolve(mounted, 'privkey.pem'),
        '-out',
        resolve(mounted, 'fullchain.pem'),
        '-subj',
        '/CN=mounted.example',
      ]);
      expect(made.status).toBe(0);

      const run = runIn(dir);
      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('NO CERTIFICATE FOR');

      const subject = spawnSync(
        'openssl',
        ['x509', '-in', resolve(run.active, 'fullchain.pem'), '-noout', '-subject'],
        { encoding: 'utf8' },
      );
      expect(subject.stdout).toContain('mounted.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the certificate entrypoint, with Let's Encrypt", () => {
  const script = resolve(ROOT, 'docker/nginx/entrypoint/10-resolve-certificates.sh');

  const issue = (dir: string, cn: string) => {
    mkdirSync(dir, { recursive: true });
    const made = spawnSync('openssl', [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-keyout',
      resolve(dir, 'privkey.pem'),
      '-out',
      resolve(dir, 'fullchain.pem'),
      '-subj',
      `/CN=${cn}`,
    ]);
    expect(made.status).toBe(0);
  };

  const run = (dir: string, domain: string) => {
    const mounted = resolve(dir, 'mounted');
    const active = resolve(dir, 'active');
    const letsencrypt = resolve(dir, 'letsencrypt');
    mkdirSync(mounted, { recursive: true });
    const result = spawnSync('sh', [script], {
      env: {
        ...process.env,
        TP_CERT_MOUNT: mounted,
        TP_CERT_ACTIVE: active,
        TP_LETSENCRYPT_DIR: letsencrypt,
        TLS_DOMAIN: domain,
      },
      encoding: 'utf8',
    });
    return { ...result, mounted, active, letsencrypt };
  };

  const subjectOf = (path: string) =>
    spawnSync('openssl', ['x509', '-in', path, '-noout', '-subject'], { encoding: 'utf8' })
      .stdout ?? '';

  it("serves the Let's Encrypt certificate when there is one", () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tp-le-'));
    try {
      issue(resolve(dir, 'letsencrypt/live/trade.example'), 'trade.example');
      const out = run(dir, 'trade.example');
      expect(out.status).toBe(0);
      expect(out.stderr).not.toContain('NO CERTIFICATE');
      expect(subjectOf(resolve(out.active, 'fullchain.pem'))).toContain('trade.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A certificate the operator put there by hand is an explicit instruction, and
   * an automated issuer must not quietly override it.
   */
  it('prefers a mounted certificate over an issued one', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tp-both-'));
    try {
      issue(resolve(dir, 'letsencrypt/live/trade.example'), 'issued.example');
      issue(resolve(dir, 'mounted'), 'operator.example');
      const out = run(dir, 'trade.example');
      expect(subjectOf(resolve(out.active, 'fullchain.pem'))).toContain('operator.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Linked rather than copied, so a renewal behind the link is picked up by a
   * reload. A copy would serve the old certificate until the container restarted
   * — up to ninety days after it stopped being valid.
   */
  it('links to the certificate rather than copying it', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tp-link-'));
    try {
      const live = resolve(dir, 'letsencrypt/live/trade.example');
      issue(live, 'first.example');
      const out = run(dir, 'trade.example');
      expect(subjectOf(resolve(out.active, 'fullchain.pem'))).toContain('first.example');

      // Renewal: the file behind the link is replaced, nothing re-runs.
      issue(live, 'renewed.example');
      expect(subjectOf(resolve(out.active, 'fullchain.pem'))).toContain('renewed.example');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('trusted proxies', () => {
  /**
   * `real_ip_header` without `set_real_ip_from` does not weaken the rate limits,
   * it removes them: any client can then claim any address, and a different one
   * on every request.
   */
  it('trusts nobody by default', () => {
    const conf = read('docker/nginx/trusted-proxies.conf');
    expect(conf).not.toMatch(/^\s*real_ip_header/m);
    expect(conf).not.toMatch(/^\s*set_real_ip_from/m);
  });

  it('names who may set the header wherever it reads one', () => {
    for (const file of readdirSync(resolve(ROOT, 'docker/nginx')).filter((n) =>
      n.startsWith('trusted-proxies.'),
    )) {
      const conf = read(`docker/nginx/${file}`);
      if (!/^\s*real_ip_header/m.test(conf)) continue;
      expect(conf).toMatch(/^\s*set_real_ip_from\s+\d/m);
    }
  });

  it('reads the trusted-proxy file before the zones that key on an address', () => {
    const conf = read('docker/nginx/nginx.conf');
    const include = conf.indexOf('include /etc/nginx/trusted-proxies.conf;');
    const firstZone = conf.indexOf('limit_req_zone');
    expect(include).toBeGreaterThan(-1);
    expect(firstZone).toBeGreaterThan(include);
  });
});

describe('ACME', () => {
  const conf = read('docker/nginx/nginx.conf');

  /**
   * Let's Encrypt fetches the challenge over port 80 and follows no redirect to
   * a certificate that does not exist yet. An unconditional 308 is how a first
   * issuance fails, on a server serving the file perfectly well one redirect
   * away.
   */
  it('answers the challenge over HTTP, ahead of the HTTPS redirect', () => {
    const challenge = conf.indexOf('location ^~ /.well-known/acme-challenge/');
    const redirect = conf.indexOf('return 308 https://');
    expect(challenge).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(challenge);
    // `^~` so a regex location cannot take it first.
    expect(conf).toMatch(/location \^~ \/\.well-known\/acme-challenge\//);
  });

  /**
   * A container with the Docker socket can start any container it likes as root
   * on the host, and `:ro` protects the socket file rather than the API behind
   * it. Reloading a web server is not worth that, and this is the guard that
   * keeps the convenient version from coming back.
   */
  it('reloads Nginx without handing any container the Docker socket', () => {
    expect(read('docker-compose.prod.yml')).not.toContain('docker.sock');
    expect(read('docker/nginx/entrypoint/20-watch-renewals.sh')).toContain('nginx -s reload');
  });
});

describe('docker-compose.cpanel.yml', () => {
  const override = read('docker-compose.cpanel.yml');

  /**
   * The whole point of the override. On a control-panel host, Apache serves
   * every site on the machine from 80 and 443; publishing this stack's edge
   * there does not conflict with one thing, it takes all of them down.
   */
  it('publishes the edge on loopback only', () => {
    expect(override).toMatch(/ports: !override/);
    for (const line of override.split('\n').filter((l) => /- '.*:\d+'/.test(l))) {
      expect(line).toContain('127.0.0.1:');
    }
    expect(override).not.toMatch(/- '(\$\{[^}]*\}|\d+):(80|443)'/);
  });

  /**
   * The panel owns the public certificate and renews it. Two issuers racing for
   * one hostname is one more than can succeed.
   */
  it('turns certbot off, because the panel already renews that hostname', () => {
    expect(override).toMatch(/certbot:[\s\S]*profiles: \['never'\]/);
  });
});

describe('image builds', () => {
  /**
   * `apk add` failing with "no such package" for something that obviously
   * exists means the index fetch failed, not the package. That happened on a
   * real deployment: Alpine's CDN answered from the host and failed
   * intermittently from inside a container, and the error named the package
   * rather than the route.
   *
   * The argument defaults to empty, so nothing changes for a build that can
   * reach the CDN. Every Dockerfile that installs a package has to accept it,
   * though — one that does not is the one that fails on such a network.
   */
  it('lets every apk-installing image be pointed at a different mirror', () => {
    for (const dockerfile of DOCKERFILES) {
      const body = read(dockerfile);
      const installs = body.split('\n').filter((line) => /^RUN .*\bapk add\b/.test(line.trim()));
      if (installs.length === 0) continue;
      expect(body, `${dockerfile} installs packages but takes no ALPINE_MIRROR`).toMatch(
        /^ARG ALPINE_MIRROR=/m,
      );
      // One ARG per build stage that installs: an ARG does not cross a FROM.
      const argCount = (body.match(/^ARG ALPINE_MIRROR=/gm) ?? []).length;
      expect(argCount).toBeGreaterThanOrEqual(installs.length);
    }
  });

  /**
   * Four lines of shell, three failures, so it is a file with a test rather than
   * a fragment repeated in four Dockerfiles. The failures are listed in the
   * script; the tests below are one per failure.
   */
  it('runs the mirror script in every image that installs packages', () => {
    for (const dockerfile of DOCKERFILES) {
      const body = read(dockerfile);
      const installs = body.split('\n').filter((line) => /^RUN .*\bapk add\b/.test(line.trim()));
      if (installs.length === 0) continue;
      const applied = (body.match(/sh \/tmp\/alpine-mirror\.sh/g) ?? []).length;
      expect(
        applied,
        `${dockerfile} installs packages without applying the mirror`,
      ).toBeGreaterThanOrEqual(installs.length);
    }
  });

  it('passes the mirror to every image compose builds', () => {
    const compose = read('docker-compose.prod.yml');
    const builds = (compose.match(/dockerfile: docker\/[a-z]+\.Dockerfile/g) ?? []).length;
    const args = (compose.match(/ALPINE_MIRROR: \$\{ALPINE_MIRROR:-\}/g) ?? []).length;
    expect(builds).toBeGreaterThan(0);
    expect(args).toBe(builds);
  });
});

describe('alpine-mirror.sh', () => {
  const script = resolve(ROOT, 'docker/alpine-mirror.sh');
  const CDN = 'https://dl-cdn.alpinelinux.org/alpine';
  const MIRROR = 'https://mirror.example.org/alpine';

  const run = (apkRoot: string, mirror?: string) =>
    spawnSync('sh', [script], {
      env: {
        ...process.env,
        APK_ROOT: apkRoot,
        ...(mirror === undefined ? {} : { ALPINE_MIRROR: mirror }),
      },
      encoding: 'utf8',
    });

  const withRoot = (build: (root: string) => void, check: (root: string) => void) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tp-apk-'));
    try {
      build(dir);
      check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * The whole prefix, not the hostname. Replacing the host alone yields
   * `.../alpine/alpine/v3.21/main`, and apk then reports the package as missing
   * — the same error as having no mirror at all, which is how it went unnoticed.
   */
  it('rewrites the whole prefix', () => {
    withRoot(
      (dir) =>
        writeFileSync(resolve(dir, 'repositories'), `${CDN}/v3.21/main\n${CDN}/v3.21/community\n`),
      (dir) => {
        expect(run(dir, MIRROR).status).toBe(0);
        const after = readFileSync(resolve(dir, 'repositories'), 'utf8');
        expect(after).toBe(`${MIRROR}/v3.21/main\n${MIRROR}/v3.21/community\n`);
        expect(after).not.toContain('alpine/alpine');
      },
    );
  });

  /**
   * The scenario that failed the build while doing its job correctly: with no
   * `repositories.d/`, the glob stays literal, `[ -f ]` is false, and in the
   * Dockerfile that false test was the last statement in the loop and so the
   * whole RUN step's exit status.
   *
   * This asserts the scenario now succeeds. It does not, and cannot, catch the
   * `&&` form coming back — what actually prevents that is structural: the exit
   * status of this script is the `found` check after the loop, not the loop.
   * Rewriting the body in the old style still passes here, which is why the fix
   * had to be the structure rather than a test.
   */
  it('succeeds when only /etc/apk/repositories exists', () => {
    withRoot(
      (dir) => writeFileSync(resolve(dir, 'repositories'), `${CDN}/v3.21/main\n`),
      (dir) => {
        const out = run(dir, MIRROR);
        expect(out.status, out.stderr).toBe(0);
      },
    );
  });

  it('handles the newer repositories.d layout too', () => {
    withRoot(
      (dir) => {
        mkdirSync(resolve(dir, 'repositories.d'), { recursive: true });
        writeFileSync(resolve(dir, 'repositories.d/main.repo'), `${CDN}/v3.22/main\n`);
      },
      (dir) => {
        expect(run(dir, MIRROR).status).toBe(0);
        expect(readFileSync(resolve(dir, 'repositories.d/main.repo'), 'utf8')).toContain(MIRROR);
      },
    );
  });

  /**
   * If Alpine moves the file again, say so here rather than letting the build
   * fail later with the misleading message this script exists to prevent.
   */
  it('fails loudly when it can find nothing to rewrite', () => {
    withRoot(
      () => {},
      (dir) => {
        const out = run(dir, MIRROR);
        expect(out.status).not.toBe(0);
        expect(out.stderr).toContain('no repository file');
      },
    );
  });

  it('does nothing at all when no mirror was asked for', () => {
    withRoot(
      (dir) => writeFileSync(resolve(dir, 'repositories'), `${CDN}/v3.21/main\n`),
      (dir) => {
        expect(run(dir).status).toBe(0);
        expect(readFileSync(resolve(dir, 'repositories'), 'utf8')).toContain(CDN);
      },
    );
  });
});

describe('the install lifecycle', () => {
  /**
   * The root `package.json` runs `prisma generate` from `prepare`, which npm
   * and pnpm run on every install. Any image that installs dependencies
   * therefore needs the schema in its context — even one that never touches a
   * database, like the web app. Without it `pnpm install` fails with
   * "schema.prisma: file not found", which reads like a missing dependency and
   * is really a missing COPY.
   */
  it('gives every installing image the prisma schema its install will look for', () => {
    const prepare = JSON.parse(read('package.json')).scripts?.prepare ?? '';
    if (!prepare.includes('prisma')) return; // the reason is gone; so is the requirement
    for (const dockerfile of DOCKERFILES) {
      const body = read(dockerfile);
      if (!/^RUN pnpm install/m.test(body)) continue;
      expect(body, `${dockerfile} installs but never copies prisma/`).toMatch(
        /^COPY prisma \.\/prisma$/m,
      );
    }
  });
});

describe('what the runtime images actually contain', () => {
  /**
   * pnpm puts a workspace package's dependencies in that package's own
   * directory, as symlinks into the root `.pnpm` store. An image that copies
   * only the root `node_modules` builds, starts, and dies immediately on
   * `Cannot find module 'reflect-metadata'` — the first thing `main.js`
   * requires.
   *
   * Every image here had that fault. They had been built in CI and never run,
   * which is exactly the gap the deployment guide warns about in its own
   * "before the first deploy" section.
   */
  it("copies each app's own node_modules, not only the workspace root's", () => {
    for (const dockerfile of DOCKERFILES) {
      const body = read(dockerfile);
      const app = /COPY --from=build[^\n]*\/app\/apps\/([a-z]+)\/dist/.exec(body)?.[1];
      if (app === undefined) continue; // not a compiled-to-dist app image
      expect(body, `${dockerfile} ships dist without apps/${app}/node_modules`).toMatch(
        new RegExp(`COPY --from=build[^\\n]*/app/apps/${app}/node_modules`),
      );
      expect(body).toMatch(/COPY --from=build[^\n]*\/app\/node_modules/);
    }
  });
});

describe('the WebSocket path', () => {
  const conf = read('docker/nginx/nginx.conf');

  /**
   * Verified against the running deployment: this configuration answers an
   * upgrade request with `101 Switching Protocols`. The test keeps the three
   * things that make that true, because each of them silently degrades the
   * socket to polling — or breaks it outright — if it goes missing.
   */
  it('carries the upgrade: HTTP/1.1, the header, and the mapped Connection', () => {
    const ws = /location \/ws \{([\s\S]*?)\n {4}\}/.exec(conf)?.[1] ?? '';
    expect(ws).toMatch(/proxy_http_version 1\.1;/);
    expect(ws).toMatch(/proxy_set_header Upgrade\s+\$http_upgrade;/);
    // Not a hard-coded "upgrade": the same location serves Socket.IO's polling
    // transport, which is not an upgrade and must not claim to be one.
    expect(ws).toMatch(/proxy_set_header Connection \$connection_upgrade;/);
    expect(conf).toMatch(/map \$http_upgrade \$connection_upgrade \{/);
  });

  /**
   * Resolved per request, through a variable, rather than by an `upstream`
   * block resolved once at startup.
   *
   * A named upstream is looked up when Nginx starts and cached for the life of
   * the process. Nginx then refuses to start at all while the API is down, and
   * after a deploy recreates the API container it holds the old address and
   * answers 502 until somebody restarts it by hand. Both happened here, twice,
   * which is twice more than a deployment that must come back at three in the
   * morning can afford.
   */
  it('resolves its upstream per request, so a redeploy needs no restart', () => {
    expect(conf).not.toMatch(/^\s*upstream\s/m);
    for (const found of conf.matchAll(/proxy_pass http:\/\/([^;\s]+);/g)) {
      expect(found[1], `${found[0]} does not go through a variable`).toMatch(/^\$/);
    }
    // A variable upstream is only resolvable if there is a resolver to do it.
    expect(conf).toMatch(/^\s*resolver\s+127\.0\.0\.11/m);
  });

  /**
   * A quiet market can go minutes without a tick. A short read timeout closes
   * every socket on a slow Sunday and reconnects them all at once, which is a
   * thundering herd nobody asked for.
   */
  it('does not close a socket that is merely quiet', () => {
    const ws = /location \/ws \{([\s\S]*?)\n {4}\}/.exec(conf)?.[1] ?? '';
    const timeout = /proxy_read_timeout (\d+)s;/.exec(ws)?.[1];
    expect(Number(timeout)).toBeGreaterThanOrEqual(600);
  });
});

/**
 * The upgrade script exists to prevent three specific failures, each of which
 * has happened on the customer's host. A test that only checked it parsed would
 * miss the point; these check that the guards are still in it.
 */
describe('scripts/upgrade-server.sh', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/upgrade-server.sh'), 'utf8');

  it('completes the environment file before it stops anything', () => {
    /**
     * The API refuses to boot with REGISTRATION_MODE=open under
     * NODE_ENV=production. An env file written before that variable existed has
     * no value for it, the default is `open`, and the refusal lands after the
     * old container is already gone. So the check must come first.
     */
    const envStep = script.indexOf('add_if_missing REGISTRATION_MODE');
    const stopStep = script.indexOf('stop api api-ws api-ingest worker');
    expect(envStep).toBeGreaterThan(0);
    expect(stopStep).toBeGreaterThan(envStep);
  });

  it('never overwrites a value an operator already chose', () => {
    // Its job is to stop the process refusing to boot, not to have opinions.
    expect(script).toMatch(/grep -qE "\^\$\{key\}=" "\$ENV_FILE"/);
  });

  it('builds one image at a time', () => {
    // `docker compose build` with no service builds every image in parallel.
    // On two cores serving live sites that saturated the machine and the host
    // rebooted.
    expect(script).toMatch(/for service in [a-z\- ]+; do\n\s+echo " {4}building \$service"/);
    expect(script).not.toMatch(/COMPOSE\[@\]}" build\s*$/m);
  });

  it('stops api-ingest as well as api', () => {
    // A separate service running the same code. Left up, the old build writes
    // ticks and fires stops against the new schema.
    expect(script).toMatch(/stop api api-ws api-ingest worker/);
  });

  /**
   * The two service lists, read from the script and checked against the compose
   * file rather than against a second hand-written list here.
   *
   * `api-ws` was in neither. Compose only recreates a container whose image or
   * configuration changed, and an image that is never rebuilt never changes, so
   * for three upgrades the real-time service — where every trader's screen is
   * connected — kept running a build from 18 September while `/health` on the
   * API reported the deployed commit and all sixteen production checks passed.
   * Found on 21 September by reading `docker ps`: "Up 2 days" beside "Up 7
   * minutes". The next service added to the compose file fails here instead.
   */
  describe('its service lists come from the compose file', () => {
    const compose = read('docker-compose.prod.yml');
    const serviceNames = compose
      .split(/\n {2}(?=[a-z])/)
      .map((block) => /^([a-z][a-z0-9-]*):/.exec(block.trim())?.[1])
      .filter((name): name is string => name !== undefined);
    const withBuild = serviceNames.filter((name) =>
      /\n {4}build:/.test(serviceBlock(compose, name) ?? ''),
    );
    /**
     * A service that runs this platform's own code against the database: built
     * from the api or worker Dockerfile. `migrate` is one of them and is the
     * exception — it is *run*, once, in the window the others are stopped for.
     */
    const applicationServices = serviceNames.filter((name) => {
      const block = serviceBlock(compose, name) ?? '';
      return /dockerfile: docker\/(api|worker)\.Dockerfile/.test(block) && name !== 'migrate';
    });

    const buildList = /for service in ([a-z\- ]+); do\n\s+echo " {4}building \$service"/
      .exec(script)?.[1]
      ?.trim()
      .split(/\s+/);
    const stopList = /"\$\{COMPOSE\[@\]\}" stop ([a-z\- ]+)\n/
      .exec(script)?.[1]
      ?.trim()
      .split(/\s+/);

    it('reads both lists and finds a plausible compose file', () => {
      // The probe that cannot fail is the one that never checked anything.
      expect(withBuild.length).toBeGreaterThanOrEqual(6);
      expect(applicationServices).toEqual(
        expect.arrayContaining(['api', 'api-ws', 'api-ingest', 'worker']),
      );
      expect(buildList, 'the build loop was found').toBeDefined();
      expect(stopList, 'the stop line was found').toBeDefined();
    });

    it('builds every service the compose file builds', () => {
      for (const service of withBuild) {
        expect(buildList, `${service} has a build: section and is never rebuilt`).toContain(
          service,
        );
      }
    });

    it('builds nothing the compose file does not define', () => {
      for (const service of buildList ?? []) {
        expect(serviceNames, `${service} is built but is not a compose service`).toContain(service);
      }
    });

    it('stops every service that runs application code before migrating, and only those', () => {
      expect([...(stopList ?? [])].sort()).toEqual([...applicationServices].sort());
    });
  });

  it('takes a backup before migrating, and checks the dump is not empty', () => {
    const backup = script.indexOf('pg_dump');
    const migrate = script.indexOf('run --rm migrate');
    expect(backup).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(backup);
    // A failed dump still leaves a file.
    expect(script).toMatch(/gzip -dc "\$OUT" \| head -c 200 \| wc -c/);
  });

  /**
   * A bind-mounted file is a mount of an inode. `git merge` writes a new file,
   * so a running nginx keeps reading the configuration it started with until
   * the container is recreated — and `up -d` does not recreate it. A raised
   * body limit was committed, deployed, and refused 3 MB at the edge with every
   * test green, because the container was still on the old file.
   */
  it('recreates nginx when its configuration changed, and only then', () => {
    const start = script.indexOf('8/9  Starting the new version');
    const recreate = script.indexOf('up -d --force-recreate nginx');
    expect(recreate).toBeGreaterThan(start);
    // Conditional on a diff of the mounted files, not unconditional: recreating
    // nginx drops the connections open at that instant.
    expect(script).toMatch(/git diff --quiet "\$BEFORE" "\$AFTER" -- docker\/nginx\//);
  });

  describe('the role row-level security applies to', () => {
    it('creates it after the migration, so the grants cover the new tables', () => {
      const migrate = script.indexOf('run --rm migrate');
      const role = script.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES');
      expect(role).toBeGreaterThan(migrate);
    });

    /**
     * The ordering that keeps a failed check from becoming an outage. The API
     * refuses to boot when `DATABASE_URL_TENANT` is set and the role turns out
     * not to be constrained — correct behaviour, and a dead site if the script
     * wrote the line and checked afterwards.
     */
    it('verifies the role is constrained before writing the variable', () => {
      /**
       * Anchored on the assignment that makes the decision, not on the query
       * text. `SELECT count(*) FROM users` appears twice — the owner's count is
       * one of them — so matching the string found the wrong occurrence and let
       * a version that wrote the variable first pass.
       */
      const check = script.indexOf('VISIBLE=$(');
      const write = script.indexOf('DATABASE_URL_TENANT=postgresql://%s');
      expect(check).toBeGreaterThan(0);
      expect(write).toBeGreaterThan(check);
    });

    it('starts the new containers after writing it, so they come up using it', () => {
      const write = script.indexOf('DATABASE_URL_TENANT=postgresql://%s');
      const start = script.indexOf('Starting the new version');
      expect(start).toBeGreaterThan(write);
    });

    it('treats an empty users table as proving nothing', () => {
      // Zero rows is only good news if there were rows to miss, and a check
      // that reads "fine" on an empty database reads "fine" on a fresh one.
      expect(script).toMatch(/proves nothing/);
    });

    it('never prints the password it generates', () => {
      // A secret in a terminal is a secret in somebody's scrollback.
      expect(script).not.toMatch(/echo[^\n]*TENANT_PASSWORD/);
      expect(script).not.toMatch(/warn[^\n]*\$TENANT_PASSWORD/);
      expect(script).toContain('unset TENANT_PASSWORD');
    });

    it('is a warning rather than a stop', () => {
      /**
       * The platform runs correctly without it, with the second isolation layer
       * disarmed for the application — which is the state every deployment was
       * in before this step existed. An upgrade is the wrong moment to refuse.
       */
      const step = script.slice(
        script.indexOf('The role row-level security applies to'),
        script.indexOf('Starting the new version'),
      );
      expect(step).toMatch(/warn "/);
      expect(step).not.toMatch(/\bdie "/);
    });

    it('leaves an existing role alone rather than resetting its password', () => {
      // Its password is not recoverable from here, and resetting somebody
      // else's database role mid-upgrade is not this script's business.
      expect(script).toMatch(/role exists but DATABASE_URL_TENANT is not set/);
    });
  });

  it('does not use pnpm inside the production image', () => {
    /**
     * The production image carries node_modules, prisma/ and the built app but
     * not the root package.json, so pnpm has no manifest to read a script from
     * and fails inside its own dependency check with a stack trace that says
     * nothing about the cause. This cost an outage: the script died on it after
     * the migration and before the containers came back.
     */
    // The comment above the fix names pnpm, so match the invocation rather
    // than the word: `run ... -c "pnpm ..."` is what must not be there.
    expect(script).not.toMatch(/-c ["']pnpm/);
    expect(script).toContain('./node_modules/.bin/tsx prisma/seed.ts');
    // `sh -c`, not `node`: .bin/tsx is a shell wrapper, not a JavaScript file.
    expect(script).toMatch(/--entrypoint sh api -c '\.\/node_modules\/\.bin\/tsx/);
  });

  it('warns on a failed seed rather than stopping half-upgraded', () => {
    // Aborting between the migration and the restart is an outage. The seed
    // refreshes instrument definitions; it is not what the platform cannot
    // start without.
    const seedBlock = script.slice(script.indexOf('tsx prisma/seed.ts'));
    expect(seedBlock.slice(0, 300)).toMatch(/warn "The seed did not run/);
  });

  it('checks that a tenant exists, which is the thing that actually blocks boot', () => {
    // The invariant, not the mechanism: the migration creates the default
    // tenant, so a failed seed does not mean there is no tenant — and a
    // successful seed does not prove there is one.
    expect(script).toMatch(/SELECT count\(\*\) FROM tenants WHERE status = 'ACTIVE'/);
    expect(script).toMatch(/die "No active tenant exists/);
  });

  it('seeds after migrating, so the default tenant exists before the API starts', () => {
    const migrate = script.indexOf('run --rm migrate');
    const seed = script.indexOf('db:seed');
    /**
     * The *command*, not the phrase. `up -d` also appears inside the migration
     * failure message, earlier in the file — which is what this assertion
     * matched on the first attempt, and it failed for a reason that had nothing
     * to do with the ordering it was checking.
     */
    const start = script.indexOf('"${COMPOSE[@]}" up -d');
    expect(seed).toBeGreaterThan(migrate);
    expect(start).toBeGreaterThan(seed);
  });

  it('waits on readiness rather than liveness', () => {
    // Liveness answers while the database is unreachable, which is exactly the
    // state a bad migration leaves behind.
    expect(script).toContain('/ready');
    expect(script).not.toContain("fetch('http://127.0.0.1:4000/health')");
  });

  it('refuses to run against a checkout that has diverged', () => {
    expect(script).toMatch(/merge --ff-only/);
  });
});

describe('scripts/first-administrator.sh', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/first-administrator.sh'), 'utf8');

  /**
   * A fresh deployment has traders and no administrator, and the only way to
   * put somebody into a role needs one. Production was found in exactly that
   * state: twenty-five users, every one of them USER, and an admin panel nobody
   * could open. The way in has to exist, and it has to be the correct act — a
   * raw UPDATE leaves the old sessions holding the old role and an audit log
   * that shows an administrator nobody appointed.
   */
  it('runs the compiled CLI inside the migrate image, which holds the code and the owner connection', () => {
    expect(script).toMatch(/run --rm --no-deps migrate/);
    expect(script).toContain('node apps/api/dist/cli/first-administrator.js "$@"');
  });

  it('points at a file the API build produces', () => {
    // dist/cli/x.js exists only if src/cli/x.ts does, and tsconfig.build.json
    // includes src/**.
    expect(existsSync(resolve(ROOT, 'apps/api/src/cli/first-administrator.ts'))).toBe(true);
    expect(read('apps/api/tsconfig.build.json')).toMatch(/"include": \["src\/\*\*\/\*\.ts"\]/);
  });

  it('is what first-deploy.sh tells the operator to run next', () => {
    expect(read('scripts/first-deploy.sh')).toContain('./scripts/first-administrator.sh --email');
  });

  it('takes no password and creates no account', () => {
    // A password typed at a host is a password in a shell history.
    expect(script).not.toMatch(/password/i);
    expect(read('apps/api/src/cli/first-administrator.ts')).not.toMatch(/user\.create\(/);
  });
});

describe('the API document in production', () => {
  /**
   * Swagger's UI mounts on Express, outside Nest's guards: whoever can reach
   * the host can read every route. The document itself is served behind
   * authentication by `/developer/openapi.json`; the UI must stay a
   * development convenience. This pins the `if` that keeps it one.
   */
  it('mounts the Swagger UI only outside production', () => {
    const main = read('apps/api/src/main.ts');
    const setup = main.indexOf('SwaggerModule.setup(');
    expect(setup).toBeGreaterThan(0);
    const guard = main.lastIndexOf('if (!isProduction)', setup);
    expect(guard).toBeGreaterThan(0);
    // The guard is the nearest enclosing block: no closing brace between it and the setup call.
    expect(main.slice(guard, setup)).not.toMatch(/\n\s*}\n/);
  });
});

describe('the backup service', () => {
  const script = read('docker/backup/backup.sh');

  it('is in the production stack, on the database, writing to a host path', () => {
    const compose = read('docker-compose.prod.yml');
    expect(compose).toMatch(/\n {2}backup:\n/);
    expect(compose).toMatch(/\.\/docker\/backup\/backup\.sh:\/backup\.sh:ro/);
    expect(compose).toMatch(/\$\{BACKUP_DIR:-\.\/backups\}:\/backups/);
  });

  it('is executable and dumps in the custom format', () => {
    expect(statSync(resolve(ROOT, 'docker/backup/backup.sh')).mode & 0o111).not.toBe(0);
    expect(script).toMatch(/pg_dump -Fc/);
  });

  /**
   * The ordering the whole script exists for: verify, then rename into place,
   * then prune. A dump that fails verification is deleted before it can be
   * pointed at, and nothing older is touched on a night the dump fails.
   */
  it('verifies a dump before it is named, and prunes only after a good one', () => {
    const verify = script.indexOf('pg_restore --list');
    const rename = script.indexOf('mv "$tmp" "$target"');
    const prune = script.indexOf('-delete');
    expect(verify).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(verify);
    expect(prune).toBeGreaterThan(rename);
    // A failed verification discards the partial file and returns before the prune.
    const failure = script.slice(verify, rename);
    expect(failure).toMatch(/rm -f "\$tmp"/);
    expect(failure).toMatch(/return 1/);
  });

  it('never writes the password anywhere but the environment', () => {
    expect(script).not.toMatch(/PGPASSWORD=/);
    expect(script).not.toMatch(/--password/);
  });
});

// ─── Observability (§63): the dashboard names only metrics that exist ──────

describe('observability stack', () => {
  const compose = read('docker-compose.observability.yml');
  const dashboard = JSON.parse(
    read('docker/observability/grafana/dashboards/trading-platform.json'),
  ) as { panels: Array<{ title: string; targets: Array<{ expr: string }> }> };
  const alerts = read('docker/observability/alerts.yml');
  const metricsSource = read('apps/api/src/metrics/metrics.service.ts');

  /**
   * Every `tp_` metric the dashboard or an alert refers to is declared in
   * `MetricsService` — or is one of prom-client's defaults under the `tp_`
   * prefix. A panel on a metric nobody emits is a flat line that looks like
   * "nothing is happening", which is the one thing a dashboard must not say
   * by accident.
   */
  const declared = new Set(
    [...metricsSource.matchAll(/name: '(tp_[a-z_]+)'/g)].map((match) => match[1]!),
  );
  const nodeDefaults = /^tp_nodejs_|^tp_process_/;
  const referenced = (text: string): string[] => [
    ...new Set([...text.matchAll(/\b(tp_[a-z_]+?)(?:_bucket|_sum|_count)?\b/g)].map((m) => m[1]!)),
  ];

  it('charts only metrics the API declares', () => {
    const exprs = dashboard.panels.flatMap((panel) => panel.targets.map((t) => t.expr)).join('\n');
    const unknown = referenced(exprs).filter(
      (name) => !declared.has(name) && !nodeDefaults.test(name),
    );
    expect(unknown).toEqual([]);
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(15);
  });

  it('alerts only on metrics the API declares', () => {
    const unknown = referenced(alerts).filter(
      (name) => !declared.has(name) && !nodeDefaults.test(name),
    );
    expect(unknown).toEqual([]);
  });

  it('covers the counters an operator is told to watch', () => {
    const exprs = dashboard.panels.flatMap((panel) => panel.targets.map((t) => t.expr)).join('\n');
    for (const metric of [
      'tp_execution_latency_seconds',
      'tp_market_feed_age_ms',
      'tp_market_ticks_total',
      'tp_reconciliation_findings_open',
      'tp_leader_lease',
      'tp_connected_sockets',
      'tp_orders_submitted_total',
    ]) {
      expect(exprs, `dashboard charts ${metric}`).toContain(metric);
    }
  });

  it('publishes Grafana on the loopback interface only, and Prometheus not at all', () => {
    const services = compose.split(/\n {2}(?=[a-z])/);
    const prometheus = services.find((b) => b.trim().startsWith('prometheus:'));
    const grafana = services.find((b) => b.trim().startsWith('grafana:'));
    expect(prometheus, 'prometheus service exists').toBeDefined();
    expect(grafana, 'grafana service exists').toBeDefined();
    expect(prometheus).not.toMatch(/\n\s+ports:/);
    // Grafana sees the shape of the whole platform; it is reached over an SSH
    // tunnel, never from the network the edge faces.
    const ports = grafana!.match(/- '[^']+'/g) ?? [];
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port).toMatch(/^- '127\.0\.0\.1:/);
    // And it insists on a password rather than starting with Grafana's default.
    expect(grafana).toMatch(/GRAFANA_ADMIN_PASSWORD:\?/);
  });

  /**
   * The table in `docs/observability.md` headed *What to alert on*, against the
   * rules that are supposed to implement it.
   *
   * That heading is an instruction to an operator, and for the life of this
   * repository it was prose. The file shipped nine alerts, the table asked for
   * nine signals, and they were a different nine: dead-letter depth, the three
   * scheduled-job signals and the isolation gauge were all listed under *alert
   * on this* with no rule anywhere. Dead-letter depth was the worst of them —
   * there was no series at all, so the row could not have been implemented by
   * anybody who tried.
   *
   * The existing checks above only run one way: every metric an alert names is
   * declared. Nothing asked whether every signal somebody was told to watch had
   * an alert, which is the direction the silence lives in.
   */
  const alertNames = [...alerts.matchAll(/^\s*- alert: (\w+)$/gm)].map((m) => m[1]!);

  /** The rule column of every row in that table. `—` where there is none. */
  const tableRows = (): Array<{ signal: string; rule: string | null }> => {
    const doc = read('docs/observability.md');
    const section = doc.slice(doc.indexOf('## What to alert on'));
    const body = section.slice(0, section.indexOf('\nFailed jobs are retained'));
    return body
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) => line.split('|').slice(1, -1))
      .filter((cells) => cells.length >= 3 && !/^[\s-]+$/.test(cells[1]!))
      .filter((cells) => !/^\s*Signal\s*$/.test(cells[0]!))
      .map((cells) => {
        const rule = /`(\w+)`/.exec(cells[1]!);
        return { signal: cells[0]!.trim(), rule: rule?.[1] ?? null };
      });
  };

  it('reads the table it is checking', () => {
    // A parser that finds nothing would make both directions below vacuous.
    const rows = tableRows();
    expect(rows.length, 'no rows parsed out of "What to alert on"').toBeGreaterThanOrEqual(10);
    expect(rows.filter((row) => row.rule !== null).length).toBeGreaterThanOrEqual(10);
  });

  it('ships a rule for every signal the documentation says to alert on', () => {
    const missing = tableRows()
      .filter((row) => row.rule !== null && !alertNames.includes(row.rule))
      .map((row) => `${row.signal} -> ${row.rule ?? ''}`);
    expect(missing, 'the table names rules that do not exist').toEqual([]);
  });

  it('documents every rule it ships', () => {
    const named = new Set(tableRows().map((row) => row.rule));
    const undocumented = alertNames.filter((name) => !named.has(name));
    // An alert nobody can find the reasoning for is one that gets silenced
    // during the incident it was written for.
    expect(undocumented, 'these rules are in no row of the table').toEqual([]);
  });

  /**
   * And the binding that does not depend on anybody remembering the table: a
   * gauge whose own help text tells the reader to alert on it must have a rule.
   * Whoever writes the next such gauge gets a failing test until they write it.
   */
  it('has a rule for every metric that asks to be alerted on', () => {
    const asks = [...metricsSource.matchAll(/name: '(tp_[a-z_]+)',\s*\n\s*help: '([^']*)'/g)]
      .filter((match) => /Alert on/i.test(match[2]!))
      .map((match) => match[1]!);
    expect(
      asks.length,
      'no metric asks to be alerted on — has the wording changed?',
    ).toBeGreaterThanOrEqual(2);
    const unalerted = asks.filter((name) => !alerts.includes(name));
    expect(unalerted, 'these say "alert on it" and nothing does').toEqual([]);
  });

  /**
   * A selector on a label the metric does not carry matches nothing, and a rule
   * whose expression matches nothing never fires and never says why — the same
   * silence this whole section is about, one level further in.
   *
   * `role` is the case that makes this worth writing rather than assuming: it
   * is not declared by any metric. It is attached by `prometheus.yml` to the
   * scrape targets, so `tp_market_feed_age_ms{role="ingest"}` is correct and a
   * check that only knew about `labelNames` would call it a bug. The allowed
   * set is therefore the union of the metric's own labels, the labels the
   * scrape configuration attaches, and the two Prometheus attaches itself.
   */
  it('selects only labels the series actually carry', () => {
    const scrapeLabels = [
      ...read('docker/observability/prometheus.yml').matchAll(/labels: \{ ([a-z_]+):/g),
    ].map((match) => match[1]!);
    const reserved = ['job', 'instance'];

    const declaredLabels = new Map<string, string[]>();
    for (const match of metricsSource.matchAll(
      /name: '(tp_[a-z_]+)',[\s\S]{0,1200}?registers: \[this\.registry\]/g,
    )) {
      const block = match[0];
      const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      const labelNames = /labelNames: \[([^\]]*)\]/.exec(block);
      declaredLabels.set(
        match[1]!,
        labelNames === null ? [] : [...labelNames[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!),
      );
      void names;
    }

    const wrong: string[] = [];
    for (const use of alerts.matchAll(/\b(tp_[a-z_]+?)(?:_bucket|_sum|_count)?\{([^}]*)\}/g)) {
      const metric = use[1]!;
      const allowed = new Set([
        ...(declaredLabels.get(metric) ?? []),
        ...scrapeLabels,
        ...reserved,
      ]);
      for (const selector of use[2]!.matchAll(/([a-z_]+)\s*=/g)) {
        if (!allowed.has(selector[1]!)) wrong.push(`${metric}{${selector[1]!}}`);
      }
    }
    expect(wrong, 'these selectors match no series, so the rule can never fire').toEqual([]);
  });

  /**
   * The two dead-letter rules, and the line between them.
   *
   * Everything above checks that a rule *exists* and is documented. Nothing
   * checked what one *says* — and a mutation proved the cost: returning the
   * page to `depth > 0` alone, which is the defect this pair was written to
   * fix, passed every check in this file.
   *
   * The pair has to partition the space. One rule for "something gave up
   * recently", one for "a backlog nobody cleared", on opposite sides of the
   * same threshold: overlapping, they both fire for one problem; with a gap,
   * a set of failures falls between them and nothing says anything.
   */
  it('splits the dead-letter alerts at one threshold, with no overlap and no gap', () => {
    const rule = (name: string): string => {
      const start = alerts.indexOf(`- alert: ${name}`);
      expect(start, `${name} is not in alerts.yml`).toBeGreaterThan(-1);
      const next = alerts.indexOf('- alert: ', start + 1);
      return alerts.slice(start, next === -1 ? undefined : next);
    };

    const page = rule('DeadLetterNotEmpty');
    const backlog = rule('DeadLetterBacklog');

    // Both are about something waiting…
    for (const [name, text] of [
      ['DeadLetterNotEmpty', page],
      ['DeadLetterBacklog', backlog],
    ] as const) {
      expect(text, `${name} does not look at the depth`).toMatch(/tp_dead_letter_depth/);
      expect(text, `${name} does not look at the age`).toMatch(/tp_dead_letter_newest_age_ms/);
    }

    // …and they divide on the age, at the same number, in opposite directions.
    const threshold = (text: string, comparison: RegExp): number => {
      const found = comparison.exec(text);
      return found === null ? Number.NaN : Number(found[1]);
    };
    const pages = threshold(page, /tp_dead_letter_newest_age_ms\)\s*<\s*(\d+)/);
    const warns = threshold(backlog, /tp_dead_letter_newest_age_ms\)\s*>=\s*(\d+)/);

    expect(pages, 'the page does not bound the age from above').not.toBeNaN();
    expect(warns, 'the backlog does not bound the age from below').not.toBeNaN();
    expect(warns, 'the two thresholds differ, so failures fall between them').toBe(pages);

    // And the louder one is the recent one.
    expect(page).toMatch(/severity: page/);
    expect(backlog).toMatch(/severity: warn/);
  });

  it('mounts the provisioning it ships, read-only', () => {
    expect(compose).toMatch(
      /docker\/observability\/prometheus\.yml:\/etc\/prometheus\/prometheus\.yml:ro/,
    );
    expect(compose).toMatch(/docker\/observability\/alerts\.yml:\/etc\/prometheus\/alerts\.yml:ro/);
    expect(compose).toMatch(
      /docker\/observability\/grafana\/provisioning:\/etc\/grafana\/provisioning:ro/,
    );
    expect(compose).toMatch(
      /docker\/observability\/grafana\/dashboards:\/var\/lib\/grafana\/dashboards:ro/,
    );
    expect(read('docker/observability/prometheus.yml')).toMatch(/alerts\.yml/);
  });
});

// ─── Secrets from files: resolved before anything reads the environment ─────

describe('file-backed secrets', () => {
  /**
   * `ConfigModule.forRoot({ validate })` validates the environment when the
   * module file is *imported*, so the resolver must run before that import —
   * which in an ES module means it must be the first import after
   * `reflect-metadata`. The worker smoke found this the hard way; this pins it
   * for both entry points without booting either.
   */
  for (const [entry, resolver] of [
    ['apps/api/src/main.ts', './config/file-secrets'],
    ['apps/worker/src/main.ts', './file-secrets'],
  ] as const) {
    it(`${entry} resolves file-backed secrets before any other import`, () => {
      const imports = [...read(entry).matchAll(/^import .*?from '([^']+)';$/gm)].map((m) => m[1]!);
      const first = imports.filter((source) => source !== 'reflect-metadata')[0];
      expect(first).toBe(resolver);
    });
  }

  it('offers a _FILE form for every secret the production example carries', () => {
    const example = read('.env.production.example');
    const secretsInExample = [...example.matchAll(/^([A-Z_]+)=/gm)]
      .map((m) => m[1]!)
      .filter((key) => /SECRET|PASSWORD|_URL$|ENCRYPTION_KEYS|SERVICE_ACCOUNT/.test(key))
      .filter((key) => !/^PUBLIC_|^APP_PUBLIC|^CORS/.test(key));
    const listed = read('packages/crypto-core/src/file-secrets.ts');
    const unlisted = secretsInExample.filter((key) => !listed.includes(`'${key}'`));
    expect(unlisted).toEqual([]);
  });
});

/**
 * The deploy scripts, checked against the thing they are supposed to make true.
 *
 * `verify:production` has a check called "the running build is the one that was
 * deployed". It works by comparing the SHA the API serves at `/health` with the
 * one the operator passes in, and the API can only serve a SHA if its image was
 * built with `BUILD_SHA`. `docker-compose.prod.yml` defaults that build argument
 * to `unknown`, which is the right default — a missing stamp should not stop a
 * deploy — but it means a script that forgets to export it fails silently and
 * produces an image that cannot say what it is.
 *
 * Both scripts forgot. Every deploy run through `upgrade-server.sh` — the
 * command `docs/deployment.md` tells you to run — produced `build: unknown`, so
 * the strongest check in the verifier degraded to "this deployment predates the
 * marker" and passed on nothing. It was found by deploying: the upgrade ran
 * green, and the verifier that runs right after it reported a build that could
 * not identify itself.
 *
 * Discovered rather than listed, so a third deploy script inherits the check.
 */
/**
 * The stamp has to land somewhere that can be read back. Compose passes
 * `BUILD_SHA` to every image it builds; an image whose Dockerfile does not take
 * it is stamped with nothing, and a process in that image answers `unknown`.
 * The worker's did not take it until the heartbeat existed to carry the
 * answer — so for as long as the marker had existed the worker was the process
 * that could not say what it was, and nobody noticed, because nothing asked.
 *
 * Every image that runs this platform's Node code and has a channel to report
 * the marker — the API (`/health`, the handshake header) and the worker (its
 * heartbeat) and the web (the `x-tp-build` response header) — must take the
 * argument in the stage that reads it and keep it as an environment variable.
 * nginx runs no code of ours.
 */
describe('the images that answer "which build?"', () => {
  const compose = read('docker-compose.prod.yml');
  const stamped = ['docker/api.Dockerfile', 'docker/worker.Dockerfile', 'docker/web.Dockerfile'];

  /**
   * Which stage has to carry it differs, and the difference is the point. The
   * API and the worker read `BUILD_SHA` at runtime, so it is the production
   * stage's environment. The web folds it into the routes manifest during
   * `next build`, so it must be in the *build* stage's environment before that
   * command — an `ENV` in the production stage would be read by nothing.
   */
  it.each(stamped)('%s takes BUILD_SHA where it is read', (file) => {
    const body = read(file);
    const stageStart = file.includes('web')
      ? body.indexOf('FROM base AS build')
      : body.lastIndexOf('FROM ');
    expect(stageStart, `${file}: the consuming stage exists`).toBeGreaterThan(-1);
    const stage = body.slice(
      stageStart,
      body.indexOf('\nFROM ', stageStart + 1) === -1
        ? undefined
        : body.indexOf('\nFROM ', stageStart + 1),
    );
    expect(stage, `${file}: the consuming stage declares ARG BUILD_SHA`).toMatch(
      /^ARG BUILD_SHA=unknown$/m,
    );
    expect(stage, `${file}: and exports it`).toMatch(/^ENV BUILD_SHA=\$BUILD_SHA$/m);
    if (file.includes('web')) {
      expect(stage.indexOf('ENV BUILD_SHA'), 'set before next build runs').toBeLessThan(
        stage.indexOf('pnpm --filter @tp/web build'),
      );
    }
  });

  it('is passed to every service compose builds from those files', () => {
    for (const file of stamped) {
      const users = compose
        .split(/\n {2}(?=[a-z])/)
        .filter((block) => block.includes(`dockerfile: ${file}`));
      expect(users.length, `${file} is used by some service`).toBeGreaterThan(0);
      for (const block of users) {
        expect(block).toMatch(/BUILD_SHA: \$\{BUILD_SHA:-unknown\}/);
      }
    }
  });
});

describe('the deploy scripts', () => {
  const SCRIPTS = readdirSync(resolve(ROOT, 'scripts'))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => `scripts/${name}`);

  /**
   * Only what the shell would run. These scripts explain themselves at length,
   * and both of the things this test looks for appear in prose too: a comment
   * in `upgrade-server.sh` discusses `docker compose build`, and
   * `bootstrap-production-env.sh` *prints* a compose command for the operator
   * to run next without building anything itself. Matching the whole file
   * found a build in a comment on line 19 and called a script that only echoes
   * one a deploy script.
   */
  const commands = (body: string): string => {
    const lines = body.split('\n');
    const kept: string[] = [];
    let heredoc: string | null = null;
    for (const line of lines) {
      if (heredoc !== null) {
        if (line.trim() === heredoc) heredoc = null;
        continue;
      }
      const opening = /<<-?'?([A-Za-z_]+)'?\s*$/.exec(line);
      if (opening) {
        heredoc = opening[1]!;
        continue;
      }
      if (/^\s*#/.test(line)) continue;
      if (/^\s*(echo|printf|say|warn|die)\b/.test(line)) continue;
      kept.push(line);
    }
    return kept.join('\n');
  };

  const BUILD_CALL = /\$\{COMPOSE\[@\]\}"? build|docker compose[^\n]*\bbuild\b/;
  const buildingScripts = SCRIPTS.filter((path) => BUILD_CALL.test(commands(read(path))));

  it('has deploy scripts that build images', () => {
    // If this ever finds none, the two tests below would pass by vacuum.
    expect(
      buildingScripts.length,
      'no script builds images — has the deploy moved?',
    ).toBeGreaterThanOrEqual(2);
  });

  for (const path of buildingScripts) {
    it(`${path} stamps the images with the commit it is deploying`, () => {
      const body = commands(read(path));
      expect(body, 'builds images without exporting BUILD_SHA').toMatch(/export BUILD_SHA/);
      // From git, not a literal: a hard-coded stamp is worse than none, because
      // it looks right.
      expect(body, 'BUILD_SHA is not read from the checkout').toMatch(
        /BUILD_SHA=\$\(git rev-parse HEAD/,
      );
      // And before the build, or the build argument is not set when it is read.
      const runnable = commands(body);
      const exported = runnable.indexOf('BUILD_SHA=$(git rev-parse HEAD');
      const built = runnable.search(BUILD_CALL);
      expect(exported, 'BUILD_SHA is set after the build that reads it').toBeLessThan(built);
    });
  }

  /**
   * And the other half of the pair: the compose file has to pass the variable
   * through to every image whose health endpoint the verifier reads.
   */
  it('passes BUILD_SHA to every image that is built from this repository', () => {
    const compose = read('docker-compose.prod.yml');
    const built = compose
      .split(/\n {2}(?=[a-z])/)
      .filter((block) => /dockerfile: docker\//.test(block));
    expect(built.length).toBeGreaterThanOrEqual(5);
    const unstamped = built
      .filter((block) => !/BUILD_SHA: \$\{BUILD_SHA:-unknown\}/.test(block))
      .map((block) => block.trim().split(':')[0]);
    expect(unstamped, 'these images cannot say what they are').toEqual([]);
  });
});

/**
 * A deploy script that fetches its own source is reading a file that is being
 * replaced underneath it, and the consequence is quiet enough that it shipped:
 * the commit above added a BUILD_SHA stamp to `upgrade-server.sh`, the deploy
 * ran green, and the API still reported `build: "unknown"` — because the half
 * of the script holding the stamp was never read.
 *
 * The first test demonstrates the mechanism rather than asserting it, so the
 * guard below cannot be removed as folklore.
 */
describe('a deploy script that updates itself', () => {
  it('keeps running the old text after the file is replaced', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'self-update-'));
    try {
      const script = resolve(dir, 'run.sh');
      const replacement = resolve(dir, 'new.sh');
      const marker = resolve(dir, 'ran');

      // `sleep` is the read boundary: bash has consumed the first line but not
      // the last when the file is swapped. The swap is a rename, exactly as
      // `git merge` replaces a changed file.
      writeFileSync(
        script,
        ['#!/usr/bin/env bash', 'sleep 0.2', `echo old >> ${marker}`, ''].join('\n'),
      );
      writeFileSync(
        replacement,
        ['#!/usr/bin/env bash', 'sleep 0.2', `echo new >> ${marker}`, ''].join('\n'),
      );

      const swap = spawnSync(
        'bash',
        ['-c', `bash ${script} & sleep 0.05; mv ${replacement} ${script}; wait`],
        { encoding: 'utf8' },
      );
      expect(swap.status, swap.stderr).toBe(0);

      // The run that replaced the script still executed the version it started
      // with. This is the whole hazard, in four lines.
      expect(readFileSync(marker, 'utf8').trim()).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restarts upgrade-server.sh on the version it just fetched', () => {
    const body = read('scripts/upgrade-server.sh');

    const merged = body.indexOf('git merge --ff-only');
    const reexec = body.indexOf('exec bash "$SELF"');
    const built = body.indexOf('"${COMPOSE[@]}" build');

    expect(reexec, 'the script does not restart itself after fetching').toBeGreaterThan(-1);
    expect(merged, 'the merge moved').toBeGreaterThan(-1);
    expect(reexec, 'it restarts before it has the new code').toBeGreaterThan(merged);
    expect(reexec, 'it restarts after the build, which is too late').toBeLessThan(built);

    // Only when this file is one of the ones that changed, or every deploy
    // restarts for nothing.
    expect(body).toMatch(/git diff --quiet "\$BEFORE_FULL" HEAD -- "\$SELF"/);
    // And not forever: the restarted run says so and does not restart again.
    expect(body).toMatch(/\$RESUMED" = false/);
    expect(body).toMatch(/--resumed\) RESUMED=true/);
  });

  /**
   * The restarted run begins *after* the merge. Its `git rev-parse HEAD` is the
   * new commit, so on the first upgrade that restarted itself the log read
   * "Already at 54c7b29. Nothing to fetch." and "Done. 54c7b29 -> 54c7b29", and
   * — the part that cost something — with BEFORE equal to AFTER the nginx step
   * could not tell whether its configuration had changed and force-recreated
   * the container, dropping every open socket, on an upgrade that never
   * touched nginx. The first run now hands its starting commit across.
   *
   * Tested by running the script's own step-1 text, not a paraphrase of it: the
   * option parser and the BEFORE/AFTER block are cut out of the file and run in
   * a clone whose HEAD and upstream are both at the new commit — the state a
   * resumed run is in. `git fetch` is a no-op there.
   */
  describe('the restarted run knows where the upgrade began', () => {
    const body = read('scripts/upgrade-server.sh');
    const parserStart = body.indexOf('RESUMED=false');
    const parserEnd = body.indexOf('COMPOSE=(');
    const stepStart = body.indexOf('if [ -n "$RESUMED_FROM" ]');
    const stepEnd = body.indexOf('# ---', stepStart);
    const snippet = [
      'set -u',
      'SKIP_BACKUP=false',
      'BUILD=true',
      'warn() { echo "WARN $1"; }',
      'git() { if [ "$1" = fetch ]; then return 0; fi; command git "$@"; }',
      body.slice(parserStart, parserEnd),
      body.slice(stepStart, stepEnd),
      'echo "BEFORE=$BEFORE AFTER=$AFTER"',
    ].join('\n');

    const run = (args: string[]) => {
      const root = mkdtempSync(resolve(tmpdir(), 'tp-resume-'));
      const remote = resolve(root, 'remote.git');
      const clone = resolve(root, 'clone');
      const git = (cwd: string, ...a: string[]) => {
        const r = spawnSync('git', a, {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
          },
        });
        expect(r.status, `${a.join(' ')}: ${r.stderr}`).toBe(0);
        return r.stdout.trim();
      };
      try {
        git(root, 'init', '-q', '--bare', '-b', 'main', remote);
        git(root, 'clone', '-q', remote, clone);
        writeFileSync(resolve(clone, 'a'), 'a');
        git(clone, 'add', 'a');
        git(clone, 'commit', '-q', '-m', 'A');
        const before = git(clone, 'rev-parse', 'HEAD');
        writeFileSync(resolve(clone, 'b'), 'b');
        git(clone, 'add', 'b');
        git(clone, 'commit', '-q', '-m', 'B');
        git(clone, 'push', '-q', '-u', 'origin', 'main');
        const after = git(clone, 'rev-parse', '--short', 'HEAD');
        const result = spawnSync(
          'bash',
          ['-c', `${snippet}`, 'x', ...args.map((a) => a.replace('<A>', before))],
          { cwd: clone, encoding: 'utf8' },
        );
        return { ...result, before: before.slice(0, 7), after };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('the pieces under test were found in the script', () => {
      expect(parserStart).toBeGreaterThan(0);
      expect(parserEnd).toBeGreaterThan(parserStart);
      expect(stepStart).toBeGreaterThan(parserEnd);
      expect(stepEnd).toBeGreaterThan(stepStart);
    });

    it('a resumed run reports the range the upgrade actually covers', () => {
      const result = run(['--resumed', '--resumed-from', '<A>']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('Already at');
      expect(result.stdout).toContain(`${result.before} -> ${result.after}`);
      expect(result.stdout).toMatch(new RegExp(`BEFORE=${result.before} AFTER=${result.after}`));
    });

    it('a first run still reads its start from the checkout', () => {
      const result = run([]);
      expect(result.status, result.stderr).toBe(0);
      // HEAD already equals upstream in this clone, so a first run has nothing to fetch.
      expect(result.stdout).toContain('Already at');
    });

    /**
     * The caller that passes `--resumed` alone is the previous version of this
     * script, restarting onto this one. The first version of this test wanted
     * that refused, the script did, and the upgrade that introduced the flag
     * stopped at step 4 on production: merged, nothing built, nothing stopped,
     * old build still serving. A flag added to a self-restarting script is
     * always first received from a caller that does not know it.
     */
    it('accepts --resumed from an older script that does not pass the commit, and says what it lost', () => {
      const result = run(['--resumed']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('older version of this script');
      // Without the range it can only start from the merged commit, as before.
      expect(result.stdout).toContain('Already at');
    });

    it('is what the restart line passes', () => {
      expect(body).toMatch(/exec bash "\$SELF" [^\n]*--resumed --resumed-from "\$BEFORE_FULL"/);
    });

    /**
     * The general form of the lesson above. Whatever the *committed* version
     * of this script passes when it restarts is what this version will be
     * called with, once, on the deploy that brings it in. So the restart line
     * is read from `HEAD`'s copy of the file — not the working tree's — and its
     * flags are fed to the working tree's parser. A flag renamed or a flag made
     * mandatory fails here, before it fails at step 4 on the host.
     */
    it('parses the flags the committed version passes when it restarts', () => {
      const committed = spawnSync('git', ['show', 'HEAD:scripts/upgrade-server.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (committed.status !== 0) return; // no history to compare against (an export, not a checkout)
      const line = /exec bash "\$SELF" \$\{ARGS\[@\]\+"\$\{ARGS\[@\]\}"\} ([^\n]+)/.exec(
        committed.stdout,
      )?.[1];
      expect(line, 'the committed script has a restart line').toBeDefined();
      const flags = (line ?? '')
        .replace(/"\$BEFORE_FULL"/g, '<A>')
        .split(/\s+/)
        .filter((token) => token !== '');
      expect(flags).toContain('--resumed');
      const result = run(flags);
      expect(
        result.status,
        `the working-tree script rejected what HEAD's passes (${flags.join(' ')}): ${result.stderr}`,
      ).toBe(0);
    });
  });
});

/**
 * Before an upgrade touches anything, it asks whether a container can reach
 * the internet — the network every build step uses.
 *
 * On 24 September an automatic CSF upgrade restarted the firewall and removed
 * Docker's NAT rules. The site kept serving; every build failed at step 5 as
 * `apk … DNS: transient error` and "no such package", which names a package
 * when what failed was the network. The probe runs `node` inside the running
 * API container through whatever compose command it is given; here that is a
 * stand-in that runs the same `node` on this machine.
 */
describe('the container egress probe', () => {
  const probe = resolve(ROOT, 'scripts/container-egress.sh');
  const withStandIn = (target: string, compose = 'stand-in') => {
    const directory = mkdtempSync(resolve(tmpdir(), 'egress-'));
    const standIn = resolve(directory, 'stand-in');
    // Drops everything before `node`, as `docker compose … exec -T api` would.
    writeFileSync(
      standIn,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != node ]; do shift; done\nexec "$@"\n',
      { mode: 0o755 },
    );
    try {
      return spawnSync('sh', [probe, compose === 'stand-in' ? standIn : compose], {
        env: { ...process.env, EGRESS_TARGET: target },
        encoding: 'utf8',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it('answers yes when the request is answered', () => {
    expect(withStandIn('data:,reachable').status).toBe(0);
  });

  it('answers no — exit 3, with the cause — when it is not', () => {
    const refused = withStandIn('http://127.0.0.1:59999/');
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/ECONNREFUSED/);
  });

  it('does not call a missing container a missing network', () => {
    // `false` stands in for a compose command that cannot exec: not an answer.
    const status = withStandIn('data:,x', 'false').status;
    expect(status).not.toBe(0);
    expect(status).not.toBe(3);
  });

  it('is asked in step 1, before the backup, the merge and the build, and stops on a no', () => {
    const script = read('scripts/upgrade-server.sh');
    const asked = script.indexOf('scripts/container-egress.sh');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(script.indexOf('say "2/9'));
    expect(asked).toBeLessThan(script.indexOf('say "3/9'));
    const handling = script.slice(asked, script.indexOf('say "2/9'));
    expect(handling).toMatch(/egress_status" -eq 3[\s\S]*die "/);
    // The message names the check and the remedy, not just the symptom.
    expect(handling).toMatch(/MASQUERADE/);
    expect(handling).toMatch(/systemctl restart docker/);
  });

  /**
   * The message and the page used to send an operator to CSF's `DOCKER = "1"`
   * as the lasting fix. On the host it was written for that cannot work: the
   * option's rules name one bridge (`docker0`), the compose networks are
   * `br-…` bridges, and the FORWARD policy is DROP. The refusal now points at
   * the page that says so, and the page must keep saying it.
   */
  it('points at a page that explains the lasting fix, and not at CSF DOCKER mode as one', () => {
    const script = read('scripts/upgrade-server.sh');
    const handling = script.slice(
      script.indexOf('scripts/container-egress.sh'),
      script.indexOf('say "2/9'),
    );
    const page = /docs\/[a-z-]+\.md/.exec(handling)?.[0];
    expect(page).toBe('docs/deployment-cpanel.md');
    const text = read(page!);
    expect(text).toMatch(/csfpost\.sh/);
    expect(text).toMatch(/FORWARD/);
    expect(handling).not.toMatch(/so it does not recur, CSF's Docker support/);
  });
});
