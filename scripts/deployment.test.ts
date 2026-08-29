import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
      expect(run.stderr).toContain('NO CERTIFICATE WAS MOUNTED');
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
      expect(run.stderr).not.toContain('NO CERTIFICATE WAS MOUNTED');

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
