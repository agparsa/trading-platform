import { describe, expect, it } from 'vitest';
import { dropped, scan } from './body-fields';

/**
 * Every field a route's request schema accepts reaches the code behind it.
 *
 * `trailingStopDistance` was added to the order schemas, honoured by the
 * service, tested at the service, shipped to the ticket — and dropped by the
 * controller, which builds the service's request field by field. The schema
 * accepted it with a 201, the order was placed without a trail, and every
 * test passed because every test called the service directly. A trader who
 * typed a trail got a position with none and no error to say so.
 *
 * The same shape can happen to any route whose handler copies fields across,
 * so the check is over all of them. What it reads, per route with a `@Body()`:
 *
 *  - the keys the zod schema behind the DTO accepts, resolved through the
 *    type checker (a name-keyed lookup compared a route against another
 *    file's `createSchema`);
 *  - the keys the handler reads, as `body.x` or destructured;
 *  - whether the handler hands the body on whole — then every key travels,
 *    and what happens to it is the service's business, not this check's.
 *
 * Passing the body to `idempotent(...)`, alone or as `{ id, ...body }`, is not
 * handing it on: that is the request's fingerprint, and it is precisely the
 * use that made the dropped field look forwarded.
 *
 * A key a route accepts and deliberately does not read is listed below with
 * the reason. The list is exact both ways: a stale entry fails too.
 */
const NOT_READ: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'trading.controller.ts preview': {
    // The preview prices margin and commission. A trail changes neither; the
    // ticket sends one order shape to both routes, so the schema is shared.
    trailingStopDistance: 'a trail does not change what the preview prices',
  },
};

const routes = scan();
const keyOf = (at: string, method: string) => `${at.split('/').pop()!.split(':')[0]} ${method}`;

describe('request-body fields reach the handler', () => {
  it('reads every schema it can find', () => {
    // A route whose schema cannot be read is a route this check silently
    // does not cover. None today; a new one has to be modelled or listed.
    const unread = routes.filter((route) => route.accepted === null);
    expect(unread.map((route) => `${route.at} ${route.method}(${route.dto})`)).toEqual([]);
    expect(routes.length).toBeGreaterThan(50);
  });

  it.each(routes.map((route) => [`${route.at} ${route.method}`, route] as const))(
    '%s reads every field it accepts',
    (_label, route) => {
      const allowed = NOT_READ[keyOf(route.at, route.method)] ?? {};
      const missing = dropped(route).filter((key) => allowed[key] === undefined);
      expect(missing, `${route.method}(${route.dto}) accepts and never reads`).toEqual([]);
    },
  );

  it('lists no exemption that is no longer needed', () => {
    for (const [where, keys] of Object.entries(NOT_READ)) {
      const route = routes.find((candidate) => keyOf(candidate.at, candidate.method) === where);
      expect(route, `${where} is exempted but not found`).toBeDefined();
      for (const key of Object.keys(keys)) {
        expect(dropped(route!), `${where} reads ${key} now; drop the exemption`).toContain(key);
      }
    }
  });
});
