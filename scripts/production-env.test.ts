import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../apps/api/src/config/env.schema';
import { workerEnvSchema } from '../apps/worker/src/env';

/**
 * The production example must actually satisfy the schemas that read it.
 *
 * This test exists because it caught a real one. `.env.production.example` named
 * the sealing key `ENCRYPTION_KEYS`; the API requires `SECRET_ENCRYPTION_KEYS`.
 * Nothing in the repository connected the two — `docker-compose.prod.yml` passes
 * the file through with `env_file`, verbatim — so the first `docker compose up`
 * on a fresh host would have died with a message about a base64 key format,
 * having never seen the value the operator carefully generated and pasted in.
 *
 * A typo in an example file is not usually worth a test. This one is: it is the
 * first thing an operator touches, the failure it causes is a long way from its
 * cause, and it is invisible to typecheck, lint and every other test here,
 * because an example file is not code.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Injected by `docker-compose.prod.yml` through the `*api-env` anchor rather
 * than by the env file, so their absence from the example is correct.
 */
const INJECTED_BY_COMPOSE = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'NODE_ENV',
  'API_HOST',
  'API_PORT',
]);

/** Read by compose itself, not by any application. */
const COMPOSE_ONLY = new Set([
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'HTTP_PORT',
  'HTTPS_PORT',
  'TLS_CERT_DIR',
  'TLS_DOMAIN',
  'TRUSTED_PROXIES_FILE',
  'EDGE_HTTP_PORT',
  'EDGE_HTTPS_PORT',
  'ALPINE_MIRROR',
  'PUBLIC_API_URL',
  'PUBLIC_WS_URL',
]);

function declaredKeys(file: string): string[] {
  return readFileSync(resolve(ROOT, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
}

function isRequired(field: unknown): boolean {
  const def = field as { isOptional?: () => boolean; _def?: { defaultValue?: unknown } };
  if (def.isOptional?.() === true) return false;
  return typeof def._def?.defaultValue === 'undefined';
}

const apiShape = (envSchema as unknown as { shape: Record<string, unknown> }).shape;
const workerShape = (workerEnvSchema as unknown as { shape: Record<string, unknown> }).shape;

describe('.env.production.example', () => {
  const declared = declaredKeys('.env.production.example');
  const available = new Set([...declared, ...INJECTED_BY_COMPOSE]);

  it('declares every variable the API cannot start without', () => {
    const missing = Object.entries(apiShape)
      .filter(([key, field]) => isRequired(field) && !available.has(key))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('declares every variable the worker cannot start without', () => {
    const missing = Object.entries(workerShape)
      .filter(([key, field]) => isRequired(field) && !available.has(key))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  /**
   * The other half of the same mistake. A key nothing reads is not harmless: it
   * is an operator setting a value and believing it took effect. `ENCRYPTION_KEYS`
   * looked exactly like a working setting right up until it wasn't one.
   */
  it('declares nothing that nothing reads', () => {
    const orphans = declared.filter(
      (key) => !(key in apiShape) && !(key in workerShape) && !COMPOSE_ONLY.has(key),
    );
    expect(orphans).toEqual([]);
  });

  it('leaves every secret blank rather than shipping one', () => {
    const lines = readFileSync(resolve(ROOT, '.env.production.example'), 'utf8').split('\n');
    const secrets = lines
      .map((line) => line.trim())
      .filter((line) => /^(JWT_[A-Z_]*SECRET|SECRET_ENCRYPTION_KEYS|POSTGRES_PASSWORD)=/.test(line))
      .filter((line) => line.slice(line.indexOf('=') + 1).trim().length > 0);
    expect(secrets).toEqual([]);
  });
});

// ─── The script that writes the real thing ─────────────────────────────────

describe('bootstrap-production-env.sh', () => {
  /**
   * The end-to-end claim: run this on a host and the platform boots.
   *
   * Checking the *example* file is not enough — the example is a template full
   * of blanks, and the thing that actually has to satisfy the schema is what the
   * bootstrap writes. This runs it for real, in a scratch copy, and parses the
   * result with the same schemas the API and worker use at startup. A missing
   * substitution, a secret too short, a base64 value mangled by a `sed`
   * expression that did not expect `/` — each of those fails here rather than on
   * the host, ten minutes after a deploy.
   */
  const bootstrap = (domain: string, cdn?: string) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tp-bootstrap-'));
    // Copy what the script writes into; link what it only reads.
    //
    // Copying `apps`, `packages` and their node_modules took twenty-three
    // seconds and timed the test out — a test that is slow enough to fail on a
    // busy machine is a test people learn to re-run rather than read. Links
    // cost nothing and the script cannot tell the difference: it writes exactly
    // one file, and that file is in a real directory.
    for (const part of ['scripts', 'docker', '.env.production.example']) {
      cpSync(resolve(ROOT, part), resolve(dir, part), { recursive: true });
    }
    for (const part of ['apps', 'packages', 'node_modules', 'tsconfig.base.json', 'package.json']) {
      symlinkSync(resolve(ROOT, part), resolve(dir, part));
    }
    const args = [resolve(dir, 'scripts/bootstrap-production-env.sh'), domain];
    if (cdn !== undefined) args.push('--cdn', cdn);
    const run = spawnSync('bash', args, { cwd: dir, encoding: 'utf8' });
    return { dir, run };
  };

  const parseEnv = (file: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!/^[A-Z][A-Z0-9_]*=/.test(t)) continue;
      out[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1);
    }
    return out;
  };

  it('writes a file both schemas accept', () => {
    const { dir, run } = bootstrap('trade.example.com', 'arvancloud');
    try {
      expect(run.status).toBe(0);
      const env = parseEnv(resolve(dir, '.env.production'));
      Object.assign(env, {
        DATABASE_URL: `postgresql://${env['POSTGRES_USER']}:${env['POSTGRES_PASSWORD']}@postgres:5432/${env['POSTGRES_DB']}?schema=public`,
        REDIS_URL: 'redis://redis:6379',
        NODE_ENV: 'production',
        API_HOST: '0.0.0.0',
        API_PORT: '4000',
      });

      const api = envSchema.safeParse(env);
      const worker = workerEnvSchema.safeParse(env);
      const issues = [
        ...(api.success
          ? []
          : api.error.issues.map((i) => `api ${i.path.join('.')}: ${i.message}`)),
        ...(worker.success
          ? []
          : worker.error.issues.map((i) => `worker ${i.path.join('.')}: ${i.message}`)),
      ];
      expect(issues).toEqual([]);

      expect(env['TLS_DOMAIN']).toBe('trade.example.com');
      expect(env['CORS_ORIGINS']).toBe('https://trade.example.com');
      expect(env['TRUSTED_PROXIES_FILE']).toBe('./docker/nginx/trusted-proxies.arvancloud.conf');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Every one of these is different every run, and none of them is the
   * placeholder that was in the template. A bootstrap that shipped the same
   * secret to every deployment would be worse than one that shipped none.
   */
  it('generates secrets rather than substituting a constant', () => {
    const first = bootstrap('a.example.com');
    const second = bootstrap('b.example.com');
    try {
      const a = parseEnv(resolve(first.dir, '.env.production'));
      const b = parseEnv(resolve(second.dir, '.env.production'));
      for (const key of [
        'POSTGRES_PASSWORD',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'SECRET_ENCRYPTION_KEYS',
      ]) {
        expect(a[key]).toBeTruthy();
        expect(a[key]).not.toBe(b[key]);
      }
      expect(a['JWT_ACCESS_SECRET']!.length).toBeGreaterThanOrEqual(32);
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  /**
   * Re-running it must not quietly rotate a live secret. Regenerating
   * SECRET_ENCRYPTION_KEYS alone locks every enrolled user out of their second
   * factor, and nobody finds out until each of them next signs in.
   */
  it('refuses to overwrite a file that already exists', () => {
    const { dir } = bootstrap('trade.example.com');
    try {
      const before = readFileSync(resolve(dir, '.env.production'), 'utf8');
      const again = spawnSync(
        'bash',
        [resolve(dir, 'scripts/bootstrap-production-env.sh'), 'trade.example.com'],
        {
          cwd: dir,
          encoding: 'utf8',
        },
      );
      expect(again.status).not.toBe(0);
      expect(again.stderr).toContain('Refusing to overwrite');
      expect(readFileSync(resolve(dir, '.env.production'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a CDN it has no ranges for, rather than trusting nothing quietly', () => {
    const { dir, run } = bootstrap('trade.example.com', 'notacdn');
    try {
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('No trusted-proxy file');
      expect(existsSync(resolve(dir, '.env.production'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
