import { API_VERSION } from '@tp/shared-types';

/**
 * Where the REST API lives under the configured origin.
 *
 * `expo.extra.apiBaseUrl` is the *origin* — `https://devopss.ir` — because
 * the socket (`/ws`) and the token refresh hang off it too. The REST client
 * was given that origin as its base, so every call went to
 * `https://devopss.ir/auth/login` rather than `/api/v1/auth/login`: the web
 * app's 404 page, on the first screen, for every trader. It was caught on
 * the first phone it was installed on, not by anything here, because the
 * client's paths are relative and nothing checked what they were relative to.
 *
 * The API mounts its routes at `/<API_GLOBAL_PREFIX>/<version>`: the prefix
 * defaults to `api` (apps/api/src/config/env.schema.ts) and the version is
 * this same `API_VERSION`. `api-root.test.ts` reads both from the API.
 */
export const API_PATH = `/api/${API_VERSION}`;

export function apiRoot(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${API_PATH}`;
}
