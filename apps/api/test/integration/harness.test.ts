import { describe, expect, it } from 'vitest';
import { assertDisposable } from './harness';

/**
 * The integration suite truncates every table it can reach. Everything else in
 * this directory tests the platform; this tests the blast radius.
 */
describe('the database the integration suite is allowed to empty', () => {
  it.each([
    'postgresql://u:p@localhost:5432/trading_platform_test',
    'postgresql://u:p@localhost:5432/trading_platform_test?schema=public',
    'postgresql://u@db:5432/anything_test?schema=public&connection_limit=5',
  ])('accepts %s', (url) => {
    expect(assertDisposable(url)).toBe(url);
  });

  /**
   * The last two are the ones that matter. `trading_platform` is one keystroke
   * from the name that is allowed, and a `_test` that is not at the end is what
   * a copied connection string looks like after somebody edited the host.
   */
  it.each([
    ['the production database', 'postgresql://u:p@prod:5432/trading_platform'],
    ['a database with no name', 'postgresql://u:p@prod:5432/'],
    ['_test in the middle', 'postgresql://u:p@prod:5432/trading_test_platform'],
    ['_test as the host, not the database', 'postgresql://u:p@db_test:5432/trading_platform'],
    ['_test only in a query parameter', 'postgresql://u:p@prod:5432/trading?schema=public_test'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertDisposable(url)).toThrow(/must end in `_test`/);
  });
});
