import { ApiClient } from '@tp/api-client';

/**
 * Server-side API client.
 *
 * The browser talks to the API directly over the public URL; this instance is
 * for React Server Components. Access tokens are added in Phase 2 — until then
 * only unauthenticated endpoints (health) are reachable.
 */
export const serverApi = new ApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
  defaultTimeoutMs: 5_000,
});

export interface ApiLiveness {
  status: string;
  uptimeSeconds: number;
  /** The API's build marker — the digest `/health` publishes. */
  build: string;
}

/**
 * Probe the API's liveness endpoint.
 *
 * Returns null rather than throwing when the API is unreachable: this page must
 * render and *say* the API is down, not 500 alongside it.
 *
 * `/health` answers inside the platform's envelope — `{ ok, data, meta }` — and
 * this read the body as though it were the data. So the one page that exists
 * to say whether the API is up said "up · undefineds" in production, to every
 * trader who followed the terminal's "Build status" link, for as long as the
 * envelope has existed. Unwrapped now, and a body that is not the envelope is
 * treated as no answer rather than as an answer with holes.
 */
export async function fetchApiLiveness(
  fetcher: typeof fetch = fetch,
  base: string = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(
    /\/api\/v\d+\/?$/,
    '',
  ),
): Promise<ApiLiveness | null> {
  try {
    const response = await fetcher(`${base}/health`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: unknown; data?: Partial<ApiLiveness> };
    const data = body.data;
    if (body.ok !== true || data === undefined) return null;
    if (typeof data.status !== 'string' || typeof data.uptimeSeconds !== 'number') return null;
    return {
      status: data.status,
      uptimeSeconds: data.uptimeSeconds,
      build: typeof data.build === 'string' ? data.build : 'unknown',
    };
  } catch {
    return null;
  }
}
