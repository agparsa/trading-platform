import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every workspace package is tested from its source, not from a stale build.
 *
 * ## The claim, and how long it was false
 *
 * `vitest.config.ts` has always carried this comment above its alias list:
 * *"Tests resolve workspace packages to their TypeScript sources, not to the
 * built `dist`. A stale build would otherwise let a test pass against code that
 * no longer exists."*
 *
 * It was true of thirteen packages out of twenty. The seven it was not true of
 * were `crypto-core`, `tenancy`, `payments-core`, `withdrawals-core`,
 * `kyc-core`, `broker-sdk` and `scheduling-core` — sealing and key rotation,
 * the firm boundary, money in and money out, identity documents, and the venue
 * adapters. Every test naming one of those imported a compiled artefact and the
 * comment said otherwise.
 *
 * ## What that cost, measured
 *
 * The `scope === undefined` guard in `tenancy` — layer one of tenant isolation,
 * the throw that stops a query running with no firm in scope — was removed from
 * the source without rebuilding the package. **All eighteen isolation tests
 * passed.** With the alias added, four of them fail immediately.
 *
 * Earlier the same day a mutation to `crypto-core` appeared to survive twice
 * and was killed the moment the package was rebuilt by hand. That was read as a
 * quirk of the mutation tooling. It was this.
 *
 * ## Why the check is here rather than in the config
 *
 * The config cannot check itself: a list that is wrong produces a passing run,
 * which is the whole problem. This reads the packages directory — something
 * nobody edits to make a test pass — and requires the list to match it.
 */

const ROOT = join(import.meta.dirname, '..');

/**
 * Packages deliberately left out, with the reason each is safe to resolve from
 * its build. Empty today; the entry exists so that skipping one is a decision
 * somebody wrote down rather than an omission nobody noticed.
 */
const EXEMPT: Record<string, string> = {};

function workspacePackages(): string[] {
  return readdirSync(join(ROOT, 'packages'))
    .filter((name) => existsSync(join(ROOT, 'packages', name, 'src')))
    .filter((name) => existsSync(join(ROOT, 'packages', name, 'package.json')))
    .sort();
}

function aliasedPackages(): Set<string> {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
  return new Set([...config.matchAll(/'@tp\/([a-z0-9-]+)':\s*pkg\(/g)].map((m) => m[1] as string));
}

describe('vitest workspace aliases', () => {
  it('resolves every workspace package to its source', () => {
    const aliased = aliasedPackages();
    const missing = workspacePackages().filter((name) => !aliased.has(name) && !(name in EXEMPT));

    expect(
      missing,
      'a package that resolves to dist is a package whose tests can pass against code that no longer exists',
    ).toEqual([]);
  });

  it('aliases nothing that is not a package', () => {
    const packages = new Set(workspacePackages());
    const stray = [...aliasedPackages()].filter((name) => !packages.has(name));
    expect(stray, 'an alias pointing at a directory that is not there resolves to nothing').toEqual(
      [],
    );
  });

  /**
   * The name each package publishes must be the one the alias uses, or the
   * alias silently does not apply and the import falls through to `dist` — the
   * exact failure this file exists to prevent, wearing a different hat.
   */
  it('uses each package’s own published name', () => {
    const wrong: string[] = [];
    for (const dir of workspacePackages()) {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'),
      ) as { name?: string };
      if (manifest.name !== `@tp/${dir}`) {
        wrong.push(`packages/${dir} publishes ${String(manifest.name)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('reads a plausible number of packages, so a broken scan cannot pass', () => {
    expect(workspacePackages().length).toBeGreaterThan(15);
    expect(aliasedPackages().size).toBeGreaterThan(15);
  });
});
