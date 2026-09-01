import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
   * Two processes ingesting the same feed double-count candle volume; two firing
   * stops race each other for the same rows. Exactly one instance does both, and
   * it is the one that serves nobody.
   */
  it('turns ingest and the trigger engine on for exactly one service', () => {
    expect(compose.match(/MARKET_INGEST_ENABLED: 'true'/g)).toHaveLength(1);
    expect(compose.match(/TRIGGER_ENGINE_ENABLED: 'true'/g)).toHaveLength(1);
    expect(compose.match(/MARKET_INGEST_ENABLED: 'false'/g)).toHaveLength(1);
    expect(compose.match(/TRIGGER_ENGINE_ENABLED: 'false'/g)).toHaveLength(1);
  });

  it('publishes ports from nginx and from nothing else', () => {
    const services = compose.split(/\n {2}(?=[a-z])/);
    const publishing = services
      .filter((block) => /\n\s+ports:/.test(block))
      .map((block) => block.trim().split(':')[0]);
    expect(publishing).toEqual(['nginx']);
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
    const stopStep = script.indexOf('stop api api-ingest worker');
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
    expect(script).toMatch(/stop api api-ingest worker/);
  });

  it('takes a backup before migrating, and checks the dump is not empty', () => {
    const backup = script.indexOf('pg_dump');
    const migrate = script.indexOf('run --rm migrate');
    expect(backup).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(backup);
    // A failed dump still leaves a file.
    expect(script).toMatch(/gzip -dc "\$OUT" \| head -c 200 \| wc -c/);
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
