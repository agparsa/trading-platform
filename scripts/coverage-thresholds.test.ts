import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The coverage thresholds have to be evaluated by something.
 *
 * ## Four numbers nobody had ever compared anything against
 *
 * `vitest.config.ts` has carried coverage thresholds since the beginning, under
 * a comment promising they "ratchet up as phases land". They were 70, and
 * nothing ever ran them: `pnpm verify` runs `pnpm test`, CI ran `pnpm test`,
 * and `pnpm test:coverage` existed in `package.json` and in no pipeline.
 *
 * The first coverage run this repository has ever done measured **95.5%**
 * statements and lines, 90.5% branches, 89.3% functions. Twenty-five points of
 * headroom on a gate that could not have fired.
 *
 * ## What this file checks, and what it deliberately does not
 *
 * It does not measure coverage — that is the coverage run's job, and running it
 * from inside itself would be circular. It checks the two things that made the
 * thresholds meaningless: that **something in CI actually runs the coverage
 * command**, and that the numbers have not been quietly lowered back to
 * decoration.
 *
 * A threshold nothing runs is worse than no threshold. It reads, to anybody
 * skimming the config, as a guarantee.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The floor below which these stop being a gate and become a decoration. */
const MINIMUM = { lines: 85, statements: 85, branches: 80, functions: 80 };

describe('coverage thresholds', () => {
  const config = read('vitest.config.ts');

  const threshold = (name: keyof typeof MINIMUM): number => {
    const found = new RegExp(`${name}:\\s*(\\d+)`).exec(config);
    expect(found, `vitest.config.ts declares no ${name} threshold`).not.toBeNull();
    return Number(found?.[1]);
  };

  it.each(Object.keys(MINIMUM) as (keyof typeof MINIMUM)[])(
    'keeps the %s threshold above the level where it stops meaning anything',
    (name) => {
      expect(threshold(name)).toBeGreaterThanOrEqual(MINIMUM[name]);
    },
  );

  /**
   * The check that would have caught the original state. A threshold is a claim
   * about what runs; if no pipeline runs the coverage command, the claim is
   * about nothing.
   */
  it('is actually run by continuous integration', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(
      /run:\s*pnpm test:coverage/.test(ci),
      'CI runs `pnpm test` without coverage, so the thresholds in vitest.config.ts are decoration',
    ).toBe(true);
  });

  it('can be run by hand, under a name somebody would guess', () => {
    const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts.scripts['test:coverage']).toContain('--coverage');
    expect(scripts.scripts['verify:coverage']).toContain('test:coverage');
  });

  /**
   * Coverage instrumentation slows the database hooks enough to time out at
   * vitest's ten-second default — which is how the first coverage run produced
   * two failures in `withdrawals` that had nothing to do with withdrawals.
   */
  it('gives the database hooks room to run under instrumentation', () => {
    const found = /hookTimeout:\s*([\d_]+)/.exec(config);
    expect(found, 'no hookTimeout is configured').not.toBeNull();
    expect(Number((found?.[1] ?? '0').replace(/_/g, ''))).toBeGreaterThanOrEqual(30_000);
  });
});
