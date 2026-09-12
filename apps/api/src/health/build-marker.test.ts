import { describe, expect, it } from 'vitest';
import { buildMarker } from './health.controller';

/**
 * The marker has two jobs that pull against each other: it must identify a
 * build to somebody who already knows which commit they deployed, and it must
 * identify nothing at all to somebody who does not.
 */
describe('buildMarker', () => {
  const SHA = '5a6afb6c0ffee1234567890abcdef01234567890';

  it('is stable for one commit and different for another', () => {
    expect(buildMarker(SHA)).toBe(buildMarker(SHA));
    expect(buildMarker(SHA)).not.toBe(buildMarker(`${SHA.slice(0, -1)}1`));
  });

  /**
   * The whole reason it is a hash. `/health` is unauthenticated, and this
   * platform deliberately keeps its route surface off the public internet —
   * publishing the exact revision of a private repository there would tell
   * anyone watching which code is running and therefore which defect to try.
   */
  it('does not contain the commit it came from', () => {
    const marker = buildMarker(SHA);
    expect(marker).not.toContain(SHA);
    expect(marker).not.toContain(SHA.slice(0, 7));
    expect(SHA).not.toContain(marker);
    expect(marker).toMatch(/^[0-9a-f]{12}$/);
  });

  /**
   * An unstamped build says so, rather than inventing an identity.
   *
   * This is the state worth catching: it means the deploy did not pass
   * `BUILD_SHA`, and the next person asking "what is running?" has no way to
   * answer — which is precisely the situation the marker exists to end.
   */
  it('says unknown when the build was not stamped', () => {
    expect(buildMarker(undefined)).toBe('unknown');
    expect(buildMarker('')).toBe('unknown');
    expect(buildMarker('unknown')).toBe('unknown');
  });

  it('ignores the whitespace a shell substitution leaves behind', () => {
    expect(buildMarker(`${SHA}\n`)).toBe(buildMarker(SHA));
    expect(buildMarker(`  ${SHA}  `)).toBe(buildMarker(SHA));
  });
});
