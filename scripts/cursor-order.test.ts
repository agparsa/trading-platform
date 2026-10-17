import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A Prisma cursor page is ordered by something unique.
 *
 * `GET /accounts/:id/ledger` paged with `cursor: { id }` over
 * `orderBy: { createdAt: 'desc' }`. Prisma cannot turn that into a keyset —
 * the order does not include the cursor's own key — so the SQL it sent was
 * every entry at or before the cursor's instant, **with no LIMIT**, and the
 * page was cut out in memory. Each page of an account with ten thousand
 * entries read up to ten thousand rows, and entries sharing one millisecond
 * were in whatever order that plan produced. With `id` as the last key the
 * same call becomes a `(created_at, id)` comparison with a LIMIT.
 *
 * So every `findMany` that takes a `cursor:` must end its `orderBy` on `id`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The text of each `findMany({...})` argument that contains a `cursor:` key. */
export function cursorQueries(source: string): string[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'findMany'
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && /\bcursor\s*:/.test(argument.getText(file))) {
        found.push(argument.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the query's `orderBy` ends on `id` — the key a cursor names. */
export function endsOnId(query: string): boolean {
  const orderBy = /orderBy\s*:\s*(\[[\s\S]*?\]|\{[^}]*\})/.exec(query)?.[1] ?? '';
  const keys = [...orderBy.matchAll(/(\w+)\s*:\s*'(?:asc|desc)'/g)].map((match) => match[1]);
  return keys[keys.length - 1] === 'id';
}

describe('cursor pages', () => {
  const sources = ts.sys
    .readDirectory(resolve(ROOT, 'apps/api/src'), ['.ts'])
    .filter((path) => !/\.(test|spec)\.ts$/.test(path));
  const queries = sources.flatMap((path) =>
    cursorQueries(readFileSync(path, 'utf8')).map((query) => ({
      file: path.slice(ROOT.length + 1),
      query,
    })),
  );

  it('finds the cursor queries, so this test is checking something', () => {
    expect(queries.map((entry) => entry.file)).toContain(
      'apps/api/src/accounts/accounts.service.ts',
    );
  });

  it('orders every one by a key that ends on id', () => {
    expect(queries.filter((entry) => !endsOnId(entry.query)).map((entry) => entry.file)).toEqual(
      [],
    );
  });

  it('reads an orderBy the way it is written', () => {
    expect(endsOnId("{ orderBy: { createdAt: 'desc' }, cursor: { id } }")).toBe(false);
    expect(endsOnId("{ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], cursor: { id } }")).toBe(
      true,
    );
    expect(endsOnId('{ cursor: { id } }')).toBe(false);
  });
});
