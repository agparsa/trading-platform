import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Tests resolve workspace packages to their TypeScript sources, not to the
     * built `dist`. A stale build would otherwise let a test pass against code
     * that no longer exists.
     */
    alias: {
      '@tp/shared-types': pkg('shared-types'),
      '@tp/financial-core': pkg('financial-core'),
      '@tp/market-core': pkg('market-core'),
      '@tp/trading-core': pkg('trading-core'),
      '@tp/risk-core': pkg('risk-core'),
      '@tp/api-client': pkg('api-client'),
      '@tp/ui': pkg('ui'),
      // The web app's own path alias, so its pure modules can be tested without
      // a Next.js build. Only non-React modules are included below.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // Integration tests share one database and truncate between cases, so they
    // must not run in parallel with each other.
    fileParallelism: false,
    testTimeout: 20_000,
    include: [
      'packages/**/src/**/*.{test,spec}.ts',
      'apps/api/src/**/*.{test,spec}.ts',
      // Pure logic only — the web app has no DOM test environment configured,
      // so anything importing React or JSX belongs in a component test instead.
      'apps/web/src/lib/**/*.{test,spec}.ts',
      'apps/worker/src/**/*.{test,spec}.ts',
      // Integration tests live inside the app so they resolve its dependencies
      // (NestJS, Prisma) the same way the application code does.
      'apps/api/test/**/*.{test,spec}.ts',
      'apps/worker/test/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts', '**/*.{test,spec}.ts'],
      thresholds: {
        // Financial correctness is non-negotiable; these ratchet up as phases land.
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
