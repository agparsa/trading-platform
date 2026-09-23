import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRoutes } from './api-inventory';

/**
 * Every path a client asks the API for, against the routes the API serves.
 *
 * The mobile app's two-factor step posted to `/auth/2fa/verify`. That route
 * has never existed — the API serves `/auth/login/2fa` — and nothing noticed,
 * because the app had never been opened and no test compared a client's paths
 * to the server's. The same comparison found the route inventory itself wrong:
 * it read one `@Controller` per file, so `GET /admin/features` and
 * `GET /admin/brokers/:id/features`, both called by the web, appeared nowhere
 * in it.
 *
 * Read statically: every `api.get|post|put|patch|delete('…')` in the web app,
 * the phone and the shared client packages, with `${…}` standing for a path
 * parameter. A call whose whole path is computed (`/admin/${kind}`) is listed
 * below with the paths it can take, and those are checked instead.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'apps/web/src',
  'apps/mobile/src',
  'packages/api-client/src',
  'packages/chart-core/src',
];

/** Calls whose path is built from a variable, and every value it can take. */
const COMPUTED: Readonly<Record<string, readonly string[]>> = {
  // apps/web/src/lib/admin-queries.ts, the firm's book: `/admin/${kind}${search}`.
  'GET /admin/**': ['GET /admin/orders', 'GET /admin/positions', 'GET /admin/trades'],
};

function files(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      found.push(...files(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

function calls(): Array<{ call: string; file: string }> {
  const found: Array<{ call: string; file: string }> = [];
  for (const source of SOURCES) {
    for (const file of files(join(ROOT, source))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /\bapi\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\(\s*(['`])([^'`]+)\2/gs,
      )) {
        const path = match[3]!.replace(/\$\{[^}]+\}/g, '*').split('?')[0]!;
        found.push({
          call: `${match[1]!.toUpperCase()} ${path}`,
          file: file.slice(ROOT.length + 1),
        });
      }
    }
  }
  return found;
}

const served = new Set(
  allRoutes().map((route) => `${route.verb} ${route.path.replace(/:[A-Za-z]+/g, '*')}`),
);

describe('every path a client calls is a route the API serves', () => {
  const found = calls();

  it('finds the calls (the probe that cannot fail is the one that never looked)', () => {
    expect(found.length).toBeGreaterThan(150);
    expect(found.some(({ file }) => file.startsWith('apps/mobile/'))).toBe(true);
    expect(served.size).toBeGreaterThan(200);
  });

  it('calls nothing the API does not serve', () => {
    const missing = found
      .flatMap(({ call, file }) => (COMPUTED[call] ?? [call]).map((one) => ({ call: one, file })))
      .filter(({ call }) => !served.has(call))
      .map(({ call, file }) => `${call}  (${file})`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('lists no computed call that the code no longer makes', () => {
    const made = new Set(found.map(({ call }) => call));
    expect(Object.keys(COMPUTED).filter((call) => !made.has(call))).toEqual([]);
  });
});
