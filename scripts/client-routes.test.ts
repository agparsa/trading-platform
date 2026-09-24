import { describe, expect, it } from 'vitest';
import { allRoutes } from './api-inventory';
import { COMPUTED_PATHS, clientCalls } from './response-contracts';

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
 * Read by the TypeScript compiler (`response-contracts.ts`, which also
 * checks the answers): every `api.<verb>(…)` in the web app, the phone and the
 * shared chart package — and `client_.…`, the name the web's mutations give
 * the same client — with `${…}` standing for a path parameter and both
 * branches of `cond ? '/a' : '/b'`. This used to be a regular expression; it
 * missed the admin KYC queue, whose path is a conditional. A call whose whole
 * path is computed (`/admin/${kind}`) is listed below with the paths it can
 * take, and those are checked instead. A path the reader cannot see at all
 * fails the test, rather than being skipped.
 */

// Calls whose path is built from a variable: `COMPUTED_PATHS` in response-contracts.ts.
const COMPUTED = COMPUTED_PATHS;

function calls(): Array<{ call: string; file: string }> {
  return clientCalls().calls.map((call) => ({ call: call.key, file: call.file }));
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

  it('can read every path a client passes', () => {
    expect(clientCalls().unread).toEqual([]);
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
