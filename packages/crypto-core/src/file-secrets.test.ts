import { describe, expect, it } from 'vitest';
import { FILE_BACKED_SECRETS, FileSecretError, resolveFileSecrets } from './file-secrets';

/**
 * `VARIABLE_FILE=/run/secrets/variable` — the convention every secrets
 * mechanism that delivers files can meet. What is pinned: only the listed
 * secrets are resolved, a trailing newline goes and nothing else does, and
 * every ambiguity is a refusal by name.
 */
const files = (contents: Record<string, string>) => (path: string) => {
  if (!(path in contents)) throw new Error(`ENOENT: ${path}`);
  return contents[path]!;
};

describe('resolveFileSecrets', () => {
  it('reads a secret from the file its pointer names, drops one trailing newline, and removes the pointer', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL_FILE: '/run/secrets/database_url',
      OTHER: 'kept',
    };
    const resolved = resolveFileSecrets(env, {
      read: files({ '/run/secrets/database_url': 'postgresql://u:p@db/x\n' }),
    });
    expect(resolved).toEqual(['DATABASE_URL']);
    expect(env['DATABASE_URL']).toBe('postgresql://u:p@db/x');
    expect(env['DATABASE_URL_FILE']).toBeUndefined();
    expect(env['OTHER']).toBe('kept');
  });

  it('removes exactly one trailing newline, and nothing inside the value', () => {
    const env: Record<string, string | undefined> = { JWT_ACCESS_SECRET_FILE: '/s' };
    resolveFileSecrets(env, { read: files({ '/s': ' a b\n\n' }) });
    expect(env['JWT_ACCESS_SECRET']).toBe(' a b\n');
  });

  it('resolves only the secrets on the list — a path variable that happens to end in _FILE is left alone', () => {
    const env: Record<string, string | undefined> = {
      TRUSTED_PROXIES_FILE: './docker/nginx/trusted-proxies.conf',
    };
    const resolved = resolveFileSecrets(env, { read: files({}) });
    expect(resolved).toEqual([]);
    expect(env['TRUSTED_PROXIES_FILE']).toBe('./docker/nginx/trusted-proxies.conf');
    expect(env['TRUSTED_PROXIES']).toBeUndefined();
  });

  it('refuses two sources for one secret, by name', () => {
    const env = { REDIS_URL: 'redis://a', REDIS_URL_FILE: '/s' };
    expect(() => resolveFileSecrets(env, { read: files({ '/s': 'redis://b' }) })).toThrow(
      FileSecretError,
    );
    expect(() => resolveFileSecrets(env, { read: files({ '/s': 'redis://b' }) })).toThrow(
      /REDIS_URL and REDIS_URL_FILE are both set/,
    );
  });

  it('refuses a file it cannot read, naming the variable and the path but never a value', () => {
    const env = { SECRET_ENCRYPTION_KEYS_FILE: '/run/secrets/keys' };
    let caught: unknown;
    try {
      resolveFileSecrets(env, { read: files({}) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileSecretError);
    expect((caught as FileSecretError).variable).toBe('SECRET_ENCRYPTION_KEYS');
    expect((caught as Error).message).toMatch(
      /SECRET_ENCRYPTION_KEYS_FILE points at \/run\/secrets\/keys/,
    );
    expect(env['SECRET_ENCRYPTION_KEYS']).toBeUndefined();
  });

  it('refuses an empty file', () => {
    const env = { DATABASE_URL_FILE: '/s' };
    expect(() => resolveFileSecrets(env, { read: files({ '/s': '\n' }) })).toThrow(/is empty/);
  });

  it('is idempotent', () => {
    const env: Record<string, string | undefined> = { REDIS_URL_FILE: '/s' };
    const read = files({ '/s': 'redis://x' });
    expect(resolveFileSecrets(env, { read })).toEqual(['REDIS_URL']);
    expect(resolveFileSecrets(env, { read })).toEqual([]);
    expect(env['REDIS_URL']).toBe('redis://x');
  });

  it('never leaks a value into the error for an unreadable neighbour', () => {
    const env = { DATABASE_URL_FILE: '/ok', REDIS_URL_FILE: '/missing' };
    const read = files({ '/ok': 'postgresql://user:hunter2@db/x' });
    let message = '';
    try {
      resolveFileSecrets(env, { read });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('hunter2');
  });

  it('lists the secrets the platform actually reads', () => {
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_ACCESS_SECRET',
      'SECRET_ENCRYPTION_KEYS',
    ]) {
      expect(FILE_BACKED_SECRETS).toContain(name);
    }
  });
});
