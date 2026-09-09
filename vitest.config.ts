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
      '@tp/reconciliation-core': pkg('reconciliation-core'),
      '@tp/integrity-core': pkg('integrity-core'),
      '@tp/api-client': pkg('api-client'),
      '@tp/push-core': pkg('push-core'),
      '@tp/webhooks-core': pkg('webhooks-core'),
      '@tp/chart-core': pkg('chart-core'),
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
      /**
       * The mobile app's pure logic only.
       *
       * There is no React Native test environment configured here, and adding
       * one would mean a second renderer in a repository that already has
       * enough moving parts. What can be tested without a device — the event
       * deduplication, the sound decisions, the token store — is exactly the
       * logic where a bug is invisible on a screenshot, so this is the half
       * worth having.
       */
      'apps/mobile/src/lib/**/*.{test,spec}.ts',
      // Integration tests live inside the app so they resolve its dependencies
      // (NestJS, Prisma) the same way the application code does.
      'apps/api/test/**/*.{test,spec}.ts',
      'apps/worker/test/**/*.{test,spec}.ts',
      // Deployment artefacts — Dockerfiles, compose, the env example. They are
      // not code, which is exactly why nothing else here checks them.
      'scripts/**/*.{test,spec}.ts',
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
