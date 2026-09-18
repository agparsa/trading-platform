import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURES, Feature } from '../packages/shared-types/src/features';

/**
 * A feature flag that nothing acts on.
 *
 * `features.ts` defines CLIENT enforcement as *the client honours it*, and
 * `feature-flags.md` went further and named the place: the "Where" column for
 * `mobile_trading` read "the mobile app". Nothing in `apps/mobile` fetched
 * `GET /features` at all. An operator could switch mobile trading off in the
 * panel, watch the switch move, and change nothing — the same shape as the
 * Argon2 knobs and the three metrics: a declaration with no reader, which reads
 * as working because everything around it is correct.
 *
 * Three of the four CLIENT flags were in that state. Two of them are for
 * features that are not built (`new_chart` waits on a licence, `white_label` on
 * a decision), which is a legitimate reason and is now written down as
 * `honoured: false` rather than left for a reader to infer.
 */

const ROOT = resolve(__dirname, '..');

/** Where a flag of each enforcement has to be acted on to count as honoured. */
const WHERE: Readonly<Record<string, readonly string[]>> = {
  SERVER: ['apps/api/src', 'apps/worker/src'],
  CLIENT: ['apps/web/src', 'apps/mobile/src'],
};

function sourceText(directory: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const child = join(path, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      parts.push(readFileSync(child, 'utf8'));
    }
  };
  walk(join(ROOT, directory));
  return parts.join('\n');
}

const TEXT: Readonly<Record<string, string>> = Object.fromEntries(
  [...new Set(Object.values(WHERE).flat())].map((directory) => [directory, sourceText(directory)]),
);

/** Referenced by its enum member or by its wire value — either is honouring it. */
function actedOnIn(directories: readonly string[], key: string, member: string): boolean {
  return directories.some(
    (directory) =>
      (TEXT[directory] ?? '').includes(`'${key}'`) ||
      (TEXT[directory] ?? '').includes(`Feature.${member}`),
  );
}

const MEMBER_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(Feature).map(([member, value]) => [value, member]),
);

describe('feature flags', () => {
  it('finds the definitions and the source it is meant to be checking', () => {
    expect(FEATURES.length).toBeGreaterThanOrEqual(7);
    for (const directory of Object.keys(TEXT)) {
      expect((TEXT[directory] ?? '').length, `${directory} read as empty`).toBeGreaterThan(1000);
    }
  });

  /**
   * The headline. A flag declared as honoured, that nothing on the side
   * responsible for honouring it mentions, is a switch that moves and does
   * nothing.
   */
  it('is acted on somewhere, for every flag that claims to be honoured', () => {
    const unread = FEATURES.filter(
      (definition) =>
        definition.honoured &&
        !actedOnIn(
          WHERE[definition.enforcement] ?? [],
          definition.key,
          MEMBER_OF[definition.key] ?? '',
        ),
    ).map((definition) => `${definition.key} (${definition.enforcement})`);
    expect(
      unread,
      'declared as honoured and acted on by nothing — the panel shows a switch that changes nothing',
    ).toEqual([]);
  });

  /**
   * The other direction, and the one that stops `honoured: false` becoming a
   * way to turn this test off: a flag marked as not honoured must say so where
   * an operator reads it, which is the description the panel renders.
   */
  it('explains every flag it declares as not honoured, in the text the panel shows', () => {
    for (const definition of FEATURES.filter((candidate) => !candidate.honoured)) {
      expect(
        definition.description,
        `${definition.key} is not honoured and its description does not say so`,
      ).toMatch(/not built|until the licence|not yet|meaningless/i);
    }
  });

  /**
   * `feature-flags.md` prints its own table of these, and its "Where" column is
   * what was wrong. A row that disagrees with the definition is how the last
   * one stayed wrong for weeks.
   */
  it('agrees with the table in feature-flags.md, row for row', () => {
    const document = readFileSync(join(ROOT, 'docs', 'feature-flags.md'), 'utf8');
    const rows = new Map<string, string[]>();
    for (const line of document.split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim());
      const key = /^`([a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
      if (key !== undefined) rows.set(key, cells);
    }
    expect(rows.size, 'the table in feature-flags.md was not found').toBeGreaterThanOrEqual(
      FEATURES.length,
    );

    for (const definition of FEATURES) {
      const cells = rows.get(definition.key);
      expect(cells, `${definition.key} is not in the table`).toBeDefined();
      expect(cells?.[2], `${definition.key} authority`).toBe(definition.authority);
      expect(cells?.[3]?.toUpperCase(), `${definition.key} enforcement`).toBe(
        definition.enforcement,
      );
      expect(cells?.[4], `${definition.key} default`).toBe(definition.default ? 'on' : 'off');
    }
  });
});
