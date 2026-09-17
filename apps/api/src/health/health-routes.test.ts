import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEALTH_ROUTES } from './health.controller';

/**
 * The global prefix's exclusion list, checked against the controller rather
 * than against itself.
 *
 * This was a hand-written literal in `main.ts` — `['health', 'health/market',
 * 'ready', 'metrics']` — and it had gone out of date. `health/jobs` was added a
 * week earlier and never excluded, so the probe answered **404** at
 * `/health/jobs`, which is the path `verify:production` polls and the path
 * `runbook.md`, `worker.md`, `backup-restore.md` and `observability.md` all
 * print. It was alive the whole time, at `/api/health/jobs`.
 *
 * Nothing caught it because every part was individually correct: the route
 * existed, the controller was right, the documents agreed with each other, and
 * the one script that would have noticed reported the 404 as "this deployment
 * predates the probe" — a plausible reading that happened to be true of
 * production for another reason entirely.
 */
const CONTROLLER = readFileSync(join(__dirname, 'health.controller.ts'), 'utf8');
const MAIN = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

/** Every path the controller serves, read from its decorators. */
function declaredRoutes(): string[] {
  return [...CONTROLLER.matchAll(/@Get\(\s*'([^']*)'\s*\)/g)]
    .map((match) => match[1])
    .filter((route): route is string => route !== undefined);
}

describe('health routes and the global prefix', () => {
  it('finds the routes it is meant to be checking', () => {
    // A parse that finds nothing would make every assertion below vacuous.
    expect(declaredRoutes().length).toBeGreaterThanOrEqual(5);
  });

  it('excludes every route the controller declares', () => {
    const missing = declaredRoutes().filter(
      (route) => !(HEALTH_ROUTES as readonly string[]).includes(route),
    );
    expect(
      missing,
      'these probes are served under the API prefix, not at the path everything calls them by',
    ).toEqual([]);
  });

  it('lists no route the controller does not declare', () => {
    const declared = declaredRoutes();
    const stale = HEALTH_ROUTES.filter((route) => !declared.includes(route));
    expect(stale, 'excluded from the prefix and served by nothing').toEqual([]);
  });

  /**
   * The list is only useful if `main.ts` actually uses it. A second literal
   * beside it would reintroduce the whole defect in one line.
   */
  it('is what main.ts excludes, rather than a literal beside it', () => {
    expect(MAIN).toContain('exclude: [...HEALTH_ROUTES');
    expect(MAIN, "a hand-written probe path in main.ts is how this went wrong").not.toMatch(
      /exclude:\s*\[\s*'health'/,
    );
  });

  /**
   * The documents and the production verifier print these paths. If a route is
   * renamed, they have to move with it.
   */
  it('serves every path the production verifier polls', () => {
    const verifier = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'verify-production.ts'),
      'utf8',
    );
    const polled = [...verifier.matchAll(/get\('\/(health[^']*)'\)/g)]
      .map((match) => match[1])
      .filter((route): route is string => route !== undefined);
    expect(polled.length).toBeGreaterThan(0);
    for (const route of polled) {
      expect(HEALTH_ROUTES as readonly string[], `${route} is polled and not excluded`).toContain(
        route,
      );
    }
  });
});
