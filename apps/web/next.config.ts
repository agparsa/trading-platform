import type { NextConfig } from 'next';

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
};

export default config;
