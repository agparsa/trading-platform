import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_PATH, apiRoot } from './api-root';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe("the phone's REST root", () => {
  it('is the origin plus the prefix and version the API mounts its routes at', () => {
    expect(apiRoot('https://devopss.ir')).toBe('https://devopss.ir/api/v1');
    expect(apiRoot('https://devopss.ir/')).toBe('https://devopss.ir/api/v1');
  });

  it("matches the API's own configuration, read from the API", () => {
    const prefix = /API_GLOBAL_PREFIX:\s*z\.string\(\)\.default\('([^']+)'\)/.exec(
      read('apps/api/src/config/env.schema.ts'),
    )?.[1];
    expect(prefix).toBe('api');
    expect(read('apps/api/src/main.ts')).toMatch(
      /setGlobalPrefix\(config\.get\('API_GLOBAL_PREFIX'/,
    );
    expect(read('apps/api/src/main.ts')).toMatch(/VersioningType\.URI/);
    expect(API_PATH).toBe(`/${prefix}/v1`);
  });

  /**
   * The bug this file exists for: the client was built on the bare origin.
   * Read from the source, because `api.ts` imports expo-constants and cannot
   * run under Node.
   */
  it('is what the app builds its REST client on, while the socket keeps the origin', () => {
    const api = read('apps/mobile/src/lib/api.ts');
    expect(api).toMatch(/baseUrl:\s*apiRoot\(apiBaseUrl\(\)\)/);
    expect(api).not.toMatch(/baseUrl:\s*apiBaseUrl\(\)\s*,/);
    expect(read('apps/mobile/src/lib/session.tsx')).toMatch(
      /apiRoot\(apiBaseUrl\(\)\)\}\/auth\/refresh/,
    );
  });
});
