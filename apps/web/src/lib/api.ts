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
}

/**
 * Probe the API's liveness endpoint.
 *
 * Returns null rather than throwing when the API is unreachable: this page must
 * render and *say* the API is down, not 500 alongside it.
 */
export async function fetchApiLiveness(): Promise<ApiLiveness | null> {
  const base = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(
    /\/api\/v\d+\/?$/,
    '',
  );
  try {
    const response = await fetch(`${base}/health`, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as ApiLiveness;
  } catch {
    return null;
  }
}
