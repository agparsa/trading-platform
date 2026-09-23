import type { NextConfig } from 'next';
import { buildMarker } from '@tp/crypto-core';

/**
 * Which build this is, on every response, as `x-tp-build`.
 *
 * The API says it in `/health`, the real-time service on its handshake and the
 * worker on its heartbeat; the web was the last container that could not be
 * asked. `verify:production` reads this from the terminal page and compares it
 * to the commit it deployed. Computed once, here, at build time: `next build`
 * folds `headers()` into the routes manifest, so the value is the `BUILD_SHA`
 * the image was *built* with — which is the question — and setting the
 * variable at runtime changes nothing, exactly as with `NEXT_PUBLIC_*`. The
 * web Dockerfile sets it in the build stage for that reason.
 */
export const BUILD_HEADER = 'x-tp-build';
const build = buildMarker();

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the production image to the server plus its traced
  // dependencies, instead of the whole monorepo.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // Workspace packages ship TypeScript-compiled CJS; Next transpiles them so a
  // single tsconfig governs the whole repo.
  transpilePackages: ['@tp/ui', '@tp/shared-types', '@tp/api-client', '@tp/financial-core'],
  typedRoutes: true,
  poweredByHeader: false,
  /**
   * The same marker, readable by the pages themselves: `/status` shows it beside
   * the API's. Inlined at build for the same reason the header is computed then.
   */
  env: { TP_WEB_BUILD: build },
  headers: async () => [{ source: '/:path*', headers: [{ key: BUILD_HEADER, value: build }] }],
};

export default config;
