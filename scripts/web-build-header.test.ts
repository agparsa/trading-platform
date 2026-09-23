import { describe, expect, it } from 'vitest';
import { buildMarker } from '@tp/crypto-core';
import config, { BUILD_HEADER } from '../apps/web/next.config';

/**
 * The web names its build on every response. This runs the real Next config —
 * the same `headers()` `next build` folds into the routes manifest — and asks
 * what it would send.
 */
describe('the web build header', () => {
  it('is on every path, and is the shared marker', async () => {
    const rules = await config.headers!();
    const everywhere = rules.find((rule) => rule.source === '/:path*');
    expect(everywhere, 'a header rule that matches every path').toBeDefined();
    const header = everywhere!.headers.find((one) => one.key === BUILD_HEADER);
    expect(header?.value).toBe(buildMarker());
    expect(header?.value).toMatch(/^([0-9a-f]{12}|unknown)$/);
  });

  it('shares its name with the socket handshake header, so one reader serves both', async () => {
    const gateway = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../apps/api/src/realtime/realtime.gateway.ts', import.meta.url),
        'utf8',
      ),
    );
    expect(gateway).toContain(`export const BUILD_HEADER = '${BUILD_HEADER}';`);
  });
});
