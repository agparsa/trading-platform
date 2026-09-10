import { resolveFileSecrets } from '@tp/crypto-core';

/**
 * `DATABASE_URL_FILE=/run/secrets/…` and friends, resolved when this module is
 * evaluated — which `main.ts` arranges to be before `worker.module.ts`, whose
 * `ConfigModule.forRoot({ validate })` reads the environment at import time.
 * See docs/secrets.md and the same file in the API.
 */
export const FILE_SECRETS_RESOLVED: readonly string[] = resolveFileSecrets(process.env);
