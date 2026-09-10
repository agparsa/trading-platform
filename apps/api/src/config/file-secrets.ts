import { resolveFileSecrets } from '@tp/crypto-core';

/**
 * Secrets delivered as files (`DATABASE_URL_FILE=/run/secrets/…`) become the
 * variables the rest of the process expects. See docs/secrets.md.
 *
 * A side-effect module, imported first in `main.ts`, for a reason found by the
 * worker's smoke check: `ConfigModule.forRoot({ validate })` runs its
 * validation when the module *file* is evaluated — at import, before any line
 * of `bootstrap()` — so resolving inside `bootstrap()` was too late and the
 * schema refused an empty `DATABASE_URL` that a file was about to supply. A
 * file that cannot be read refuses to boot here, by variable name, rather than
 * as a connection error a minute later.
 */
export const FILE_SECRETS_RESOLVED: readonly string[] = resolveFileSecrets(process.env);
