import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency audit, and the two lists that make it mean something.
 *
 * `docs/penetration-checklist.md` explains why the penetration suite does not
 * check dependencies: "`pnpm audit` belongs in CI, not in a script that boots
 * the API." The reasoning is right and CI did not run it, so nothing did. The
 * first run found **22 advisories — 2 critical, 11 high** — including `multer`,
 * reached through `@nestjs/platform-express`, which is the path identity
 * documents are uploaded over.
 *
 * A gate alone would not have been enough either. The two ways to make an audit
 * pass without fixing anything are to override a dependency quietly and to add
 * the advisory to an ignore list, and both look like green builds. So each is
 * bound to a written reason here, in both directions: something pinned or
 * ignored with no entry fails, and an entry for something no longer pinned or
 * ignored fails too — because a decisions file nobody has to maintain becomes
 * folklore, and the next reader cannot tell which rows still apply.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

describe('the dependency audit', () => {
  const pkg = JSON.parse(read('package.json')) as {
    pnpm?: {
      overrides?: Record<string, string>;
      auditConfig?: { ignoreCves?: string[]; ignoreGhsas?: string[] };
    };
  };
  const workflow = read('.github/workflows/ci.yml');
  const decisions = read('security/dependencies.md');

  it('runs in CI, on every build', () => {
    const step = /run: pnpm audit([^\n]*)/.exec(workflow);
    expect(step, 'no CI step runs pnpm audit').not.toBeNull();
    // With an explicit threshold: `pnpm audit` with no level fails on anything
    // at all, which is a gate that gets removed the first week rather than a
    // line somebody decided to hold.
    expect(step![1], 'the audit runs without a stated threshold').toMatch(/--audit-level=\w+/);
  });

  it('holds the line at high or stricter', () => {
    const level = /--audit-level=(\w+)/.exec(workflow)?.[1];
    // `critical` only would have passed the run that found eleven highs,
    // `multer` among them.
    expect(['high', 'moderate', 'low'], `audit level is '${level ?? 'none'}'`).toContain(level);
  });

  it('explains every override, and pins everything it explains', () => {
    const overrides = Object.keys(pkg.pnpm?.overrides ?? {});
    // An override applies to every package in the workspace, including ones
    // that asked for something else. It is a dependency decision, and an
    // unexplained one is a decision nobody reviewed.
    const unexplained = overrides.filter((name) => !decisions.includes(`\`${name}\``));
    expect(unexplained, 'these are overridden and nothing says why').toEqual([]);

    // And the other direction: a row for a package no longer overridden is a
    // reason a reader will apply to a pin that is not there.
    // Cells padded or not: Prettier aligns a table's columns, and a parser that
    // wanted exactly one space found no rows the day the file was formatted.
    const rows = [...decisions.matchAll(/^\| `([@a-z0-9/-]+)`\s+\| `([^`]+)`\s+\|/gm)].map(
      (match) => match[1]!,
    );
    expect(rows.length, 'no override rows parsed out of the decisions file').toBeGreaterThan(0);
    const stale = rows.filter((name) => !overrides.includes(name));
    expect(stale, 'the decisions file explains overrides that are gone').toEqual([]);
  });

  it('explains every advisory it has chosen to ignore', () => {
    const ignored = [
      ...(pkg.pnpm?.auditConfig?.ignoreCves ?? []),
      ...(pkg.pnpm?.auditConfig?.ignoreGhsas ?? []),
    ];
    const unexplained = ignored.filter((id) => !decisions.includes(id));
    // An ignore list is where a gate goes to die quietly. Each entry names its
    // advisory here, or the build says so.
    expect(unexplained, 'these advisories are silenced and nothing says why').toEqual([]);
  });

  it('is the place the penetration checklist says it is', () => {
    const checklist = read('docs/penetration-checklist.md');
    // The bullet itself, not a fixed window from the phrase: the first version
    // of this read 400 characters from `pnpm audit` and stopped one sentence
    // short of the answer, which is the same mistake as a guard that reads
    // prose it happens to reach.
    const bullet = /- \*\*Dependency vulnerabilities\.\*\*[\s\S]*?(?=\n- \*\*|\n## |$)/.exec(
      checklist,
    );
    expect(bullet, 'the checklist no longer has that bullet').not.toBeNull();
    const claim = bullet![0];
    expect(claim, 'the bullet is too short to say anything').toMatch(/pnpm audit/);
    expect(claim, 'the checklist still delegates this somewhere unnamed').toMatch(
      /\.github\/workflows\/ci\.yml/,
    );
    expect(claim).toMatch(/security\/dependencies\.md/);
  });
});
