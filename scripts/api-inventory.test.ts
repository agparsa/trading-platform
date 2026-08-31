import { describe, expect, it } from 'vitest';
import { documentTable, generatedTable, normalise } from './api-inventory';

/**
 * `docs/API_INVENTORY.md` says it is generated from the controllers.
 *
 * A document that claims that and then drifts is worse than one that never
 * claimed it, because a reader who trusts the claim stops checking. This test
 * makes the claim true: add a route, change a permission, or delete a
 * controller, and the build fails until `pnpm inventory` has been run.
 */
describe('docs/API_INVENTORY.md', () => {
  it('matches the controllers it is generated from', () => {
    expect(normalise(documentTable())).toBe(normalise(generatedTable()));
  });

  it('records a permission for every mutating route, or says why not', () => {
    /**
     * The same rule `permissions-coverage.test.ts` enforces in the controllers,
     * asserted against the published inventory — so a reader of the document
     * can trust that an empty Requires column would have failed the build.
     */
    const undeclared = normalise(documentTable())
      .split('\n')
      .filter((line) => /^\| `(POST|PATCH|PUT|DELETE)`/.test(line))
      .filter((line) => line.endsWith('| _authenticated only_ |'));

    expect(undeclared).toEqual([]);
  });

  it('exposes no route whose path still contains a template placeholder', () => {
    // A `${...}` surviving into the table means the parser mis-read a decorator
    // rather than that such a route exists.
    expect(documentTable()).not.toMatch(/\$\{/);
  });
});
