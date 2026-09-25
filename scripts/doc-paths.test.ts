import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every file a page about the present names is a file that exists.
 *
 * Three pages pointed at files that had moved: `deployment.md` at an API test
 * that became `scripts/production-env.test.ts`, `encryption-at-rest.md` at a
 * secret box that became `packages/crypto-core`, and `mobile.md` at a sound
 * generator by a path relative to a directory the page never named. A reader
 * who opens the file a document cites and finds nothing stops trusting the
 * rest of the document, reasonably.
 *
 * Dated records — the audits against a named baseline, the plan's history —
 * describe the repository as it was, and are left alone. Paths that are
 * absent on purpose are listed with the reason.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DATED = new Set([
  'ADMIN_AUDIT.md',
  'ARCHITECTURE_AUDIT.md',
  'COMPLETION_STATUS.md',
  'DATABASE_AUDIT.md',
  'IMPLEMENTATION_PLAN.md',
  'MOBILE_AUDIT.md',
  'SECURITY_AUDIT.md',
  'TRADING_AUDIT.md',
  'architecture-audit.md',
  'final-audit.md',
]);

const ABSENT_ON_PURPOSE: Readonly<Record<string, string>> = {
  'apps/web/public/charting_library/': 'the licensed TradingView bundle, git-ignored',
  'apps/web/public/datafeeds/': 'the licensed TradingView bundle, git-ignored',
  'packages/broker-sdk/src/connectors/': 'where a first real connector would go; none exists',
  'apps/web/src/lib/datafeed.ts': 'charting.md names it as where the seam used to live',
};

const PATH = /`((?:apps|packages|scripts|docker|docs|prisma|\.github)\/[A-Za-z0-9_./[\]()@-]+)`/g;

const cited = (): Array<{ page: string; path: string }> =>
  [
    ...readdirSync(resolve(ROOT, 'docs'))
      .filter((name) => name.endsWith('.md') && !DATED.has(name))
      .map((name) => `docs/${name}`),
    'README.md',
  ].flatMap((page) =>
    [...readFileSync(resolve(ROOT, page), 'utf8').matchAll(PATH)]
      .map((match) => match[1]!.replace(/\.$/, ''))
      .filter((path) => !path.includes('*') && !path.includes('<'))
      .map((path) => ({ page, path })),
  );

describe('the files the documents cite', () => {
  const all = cited();

  it('are found (the probe that cannot fail is the one that never looked)', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('exist', () => {
    const missing = all
      .filter(({ path }) => ABSENT_ON_PURPOSE[path] === undefined)
      .filter(({ path }) => !existsSync(resolve(ROOT, path)))
      .map(({ page, path }) => `${page}: ${path}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('list nothing as absent on purpose that has since appeared, or that no page cites', () => {
    const paths = new Set(all.map(({ path }) => path));
    for (const path of Object.keys(ABSENT_ON_PURPOSE)) {
      expect(existsSync(resolve(ROOT, path)), `${path} exists now`).toBe(false);
      expect(paths.has(path), `${path} is cited by no page`).toBe(true);
    }
  });
});
