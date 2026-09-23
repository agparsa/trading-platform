import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every screen the web application serves, against the three hand-kept lists
 * that describe it.
 *
 * `docs/web-routes.md` opens "every screen has an address now" and carried a
 * table of them. On 23 September the app directory had 35 pages and the table
 * 27: `/developer`, `/admin/book`, `/admin/desks`, `/admin/withdrawals`,
 * `/admin/reports`, `/admin/connections`, `/admin/webhooks` and
 * `/admin/features` had each shipped without a row — an operator looking for
 * the withdrawal queue in the map of the application would not find it. The
 * navigation lists had kept up; nothing compared the document to either.
 *
 * So the routes are read from the filesystem, the way Next reads them, and:
 *
 * - the document's table names exactly those routes;
 * - the admin navigation links every admin section, and nothing else;
 * - the application shell's navigation links only pages that exist;
 * - `pnpm smoke:web` opens every route in a real browser, bar the ones it
 *   reaches another way, each named here with the reason.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/web/src/app');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** `app/(app)/wallet/page.tsx` → `/wallet`; `[id]` → `:id`. */
function routes(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'page.tsx') {
        const route = relative(APP, directory)
          .split('/')
          .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
          .map((segment) => segment.replace(/^\[(.+)\]$/, ':$1'))
          .join('/');
        found.push(`/${route}`);
      }
    }
  };
  walk(APP);
  return found.sort();
}

/** The first column of the map table in docs/web-routes.md. */
function documented(): string[] {
  const map = read('docs/web-routes.md').split('## The map')[1]?.split('\n## ')[0] ?? '';
  return [...map.matchAll(/^\| `([^`]+)` /gm)].map((match) => match[1]!).sort();
}

const hrefs = (source: string) => [...source.matchAll(/href: '([^']+)'/g)].map((m) => m[1]!);

/**
 * Routes the browser smoke reaches without a `visit(...)` naming them, and
 * why. An entry here is a claim a reader can check against smoke-web.ts.
 */
const REACHED_OTHERWISE: Readonly<Record<string, string>> = {
  '/login': 'signIn() drives the form on it before every signed-in visit',
  '/admin/overview': "visit(adminPage, '/admin', { url: '/admin/overview' }) lands on it",
};

describe('web routes', () => {
  const all = routes();

  it('finds the application (the probe that cannot fail is the one that never looked)', () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(all).toEqual(expect.arrayContaining(['/', '/terminal', '/admin/people/:id']));
  });

  it('docs/web-routes.md maps exactly the routes the application serves', () => {
    const doc = documented();
    expect(
      all.filter((route) => !doc.includes(route)),
      'served, and not in the map',
    ).toEqual([]);
    expect(
      doc.filter((route) => !all.includes(route)),
      'in the map, and not served',
    ).toEqual([]);
  });

  it('the admin navigation links every admin section, and only those', () => {
    const sections = all.filter((route) => /^\/admin\/[a-z-]+$/.test(route));
    const nav = hrefs(read('apps/web/src/app/admin/layout.tsx'));
    expect([...nav].sort()).toEqual(sections);
  });

  it("the application shell's navigation links only pages that exist", () => {
    const nav = hrefs(read('apps/web/src/components/shell/app-shell.tsx'));
    expect(nav.length).toBeGreaterThan(3);
    expect(nav.filter((href) => !all.includes(href))).toEqual([]);
  });

  it('the browser smoke opens every route, or says how it reaches it', () => {
    const smoke = read('scripts/smoke-web.ts');
    const visited = new Set(
      [...smoke.matchAll(/visit\(\s*[a-zA-Z]+,\s*['`]([^'`$]+)/g)].map((m) =>
        m[1]!.replace(/\/$/, '') === '' ? '/' : m[1]!.replace(/\/$/, ''),
      ),
    );
    const unvisited = all.filter((route) => {
      if (REACHED_OTHERWISE[route] !== undefined) return false;
      if (!route.includes(':')) return !visited.has(route);
      // A dynamic route is visited through a template: `/admin/people/${id}`.
      const prefix = route.replace(/:[a-z]+$/, '');
      return !smoke.includes(`visit(adminPage, \`${prefix}\${`);
    });
    expect(unvisited, 'a page nobody opens in a browser').toEqual([]);
    // And every exemption still names a real route.
    expect(Object.keys(REACHED_OTHERWISE).filter((route) => !all.includes(route))).toEqual([]);
  });
});
