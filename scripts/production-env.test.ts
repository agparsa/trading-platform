import { readFileSync } from 'node:fs';
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
