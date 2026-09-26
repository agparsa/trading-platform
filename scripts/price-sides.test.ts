import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Which side of the book a price comes from is decided in one place.
 *
 * `docs/pnl.md` said `sides.ts` is the single place that decision is made and
 * nothing else in the codebase picks a price side. Five files did, each with
 * its own `side === 'BUY' ? ask : bid` — among them the server's valuation of
 * every open position, the one that sets equity. All five were right. None was
 * held to it, and the next one written the other way round would value every
 * long at the ask: equity overstated by the spread, on every position, with
 * nothing failing.
 *
 * So every choice between a bid and an ask — a conditional whose two branches
 * are a bid and an ask — is found in the source, and only `sides.ts` may make
 * one. Callers ask `entrySideOf` / `exitSideOf` which key to read.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'packages/financial-core/src/formulas/sides.ts';

/** Places that choose a side for a reason the platform's rule does not cover. */
const EXEMPT: Readonly<Record<string, string>> = {
  'packages/broker-sdk/src/mock-adapter.ts':
    'a simulated venue filling its own orders; it stands in for the exchange, not the platform, and depends on nothing but shared-types',
};

const ROOTS = ['apps', 'packages'];
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return [
        'node_modules',
        'dist',
        '.next',
        'build',
        'test',
        '__fixtures__',
        'android',
        'ios',
      ].includes(entry.name)
        ? []
        : sources(path);
    }
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });

/** `bid` or `ask` when an expression reads one, by the name it reads it under. */
const sideRead = (expr: ts.Expression): 'bid' | 'ask' | null => {
  let name: string | null = null;
  if (ts.isPropertyAccessExpression(expr)) name = expr.name.text;
  else if (ts.isIdentifier(expr)) name = expr.text;
  else if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
    name = expr.argumentExpression.text;
  } else if (ts.isStringLiteral(expr)) name = expr.text;
  if (name === null) return null;
  if (/bid$/i.test(name)) return 'bid';
  if (/ask$/i.test(name)) return 'ask';
  return null;
};

const choices = (): string[] =>
  ROOTS.flatMap((top) =>
    readdirSync(resolve(ROOT, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => sources(resolve(ROOT, top, entry.name))),
  ).flatMap((file) => {
    const path = relative(ROOT, file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node)) {
        const a = sideRead(node.whenTrue);
        const b = sideRead(node.whenFalse);
        if (a !== null && b !== null && a !== b) {
          found.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });

describe('choosing a side of the book', () => {
  const found = choices();

  it('finds the rule itself (the probe that cannot fail is the one that never looked)', () => {
    expect(found.some((at) => at.startsWith(`${RULE}:`))).toBe(true);
  });

  it('happens only in sides.ts', () => {
    const elsewhere = found.filter(
      (at) =>
        !at.startsWith(`${RULE}:`) &&
        !Object.keys(EXEMPT).some((file) => at.startsWith(`${file}:`)),
    );
    expect(elsewhere).toEqual([]);
  });

  it('exempts only files that still make the choice', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(
        found.some((at) => at.startsWith(`${file}:`)),
        file,
      ).toBe(true);
    }
  });
});
