import { readFileSync } from 'node:fs';

/**
 * Secrets from files, not only from the environment.
 *
 * Every secret this platform reads arrives as an environment variable, and an
 * environment variable is the least private place a secret can live: it is in
 * `docker inspect`, in `/proc/<pid>/environ`, in a crash dump, in whatever a
 * child process inherits. Docker secrets, Kubernetes secrets, Vault Agent,
 * External Secrets and the like all deliver a secret the same other way — as a
 * file with restrictive permissions, mounted into the container — and every
 * one of them documents the same convention for telling an application where:
 * `VARIABLE_FILE=/run/secrets/variable`.
 *
 * So the platform honours that convention for the variables that *are*
 * secrets, and only those. A generic "any `_FILE` suffix" rule would have read
 * `TRUSTED_PROXIES_FILE` — a genuine path the edge is given — and refused to
 * boot when the file was not inside the API container. The list below is the
 * contract; adding a secret to the platform means adding it here.
 *
 * Rules, each one a refusal rather than a guess:
 *  - both `X` and `X_FILE` set → refuse; two sources for one secret means one
 *    of them is stale, and nobody should have to know which wins;
 *  - `X_FILE` names a file that cannot be read → refuse, naming the variable
 *    and the path (the path is not secret; the contents are never printed);
 *  - an empty file → refuse; a secret that is empty is a mount that failed.
 * A single trailing newline is removed — editors add one, secrets do not carry
 * one — and nothing else is touched.
 *
 * What this is not: a client for any secrets manager's API. Vault, AWS Secrets
 * Manager, GCP Secret Manager and Azure Key Vault each need their SDK, their
 * credentials and their rotation semantics, and choosing one is the
 * operator's decision, not this repository's. Every one of them can deliver
 * a file; this is the interface they all meet. Rotation of a mounted file is
 * picked up at the next process start — the platform reads secrets once, at
 * boot — which is the same moment `SECRET_ENCRYPTION_KEYS` rotation already
 * takes effect (see docs/security.md).
 */
export const FILE_BACKED_SECRETS: readonly string[] = [
  'DATABASE_URL',
  'DATABASE_URL_TENANT',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'SECRET_ENCRYPTION_KEYS',
  'FCM_SERVICE_ACCOUNT_JSON',
  'POSTGRES_PASSWORD',
  'GRAFANA_ADMIN_PASSWORD',
];

export interface FileSecretsOptions {
  /** Which variables may be file-backed. Defaults to `FILE_BACKED_SECRETS`. */
  readonly allowed?: readonly string[];
  /** How a file is read; injectable so tests need no filesystem. */
  readonly read?: (path: string) => string;
}

export class FileSecretError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileSecretError';
  }
}

/**
 * Resolves `X_FILE` into `X` for every allowed secret, in place, and returns
 * the names it resolved. Idempotent: a second call finds `X` set and `X_FILE`
 * absent (it is removed once read) and does nothing.
 */
export function resolveFileSecrets(
  env: Record<string, string | undefined>,
  options: FileSecretsOptions = {},
): string[] {
  const allowed = options.allowed ?? FILE_BACKED_SECRETS;
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const resolved: string[] = [];

  for (const name of allowed) {
    const pointer = `${name}_FILE`;
    const path = env[pointer];
    if (path === undefined || path === '') continue;

    if (env[name] !== undefined && env[name] !== '') {
      throw new FileSecretError(
        name,
        `${name} and ${pointer} are both set. One secret, one source: unset whichever is stale.`,
      );
    }

    let contents: string;
    try {
      contents = read(path);
    } catch (error) {
      throw new FileSecretError(
        name,
        `${pointer} points at ${path}, which could not be read (${
          error instanceof Error ? error.message : String(error)
        }). Is the secret mounted into this container?`,
      );
    }

    const value = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
    if (value.length === 0) {
      throw new FileSecretError(
        name,
        `${pointer} points at ${path}, which is empty. An empty secret is a mount that failed.`,
      );
    }

    env[name] = value;
    // The pointer has done its job; leaving it would make a later pass see two
    // sources, and it is one less path to leak into a child's environment.
    delete env[pointer];
    resolved.push(name);
  }

  return resolved;
}
