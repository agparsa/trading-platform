import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Middleware routes are written in the form Express 5's router accepts.
 *
 * Every API, socket and ingest process logged three warnings at boot —
 * `Unsupported route path: "/api/*"` — one for the tenant middleware's
 * `forRoutes('*')` and two for nestjs-pino's default, which is the same bare
 * `*`. Nest rewrote each to `/api/{*path}` and carried on, so nothing was
 * broken; what it cost was nine warnings on every start in the logs a person
 * reads during an incident, teaching them that warnings here mean nothing.
 *
 * So no middleware route may be a legacy wildcard, and the HTTP app's logger
 * must name its routes rather than inherit the library's default.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = new Set(['*', '/*', '/*/', '(.*)', '/(.*)']);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

interface Found {
  readonly legacy: string[];
  readonly loggers: Array<{ at: string; routes: boolean }>;
}

function scan(): Found {
  const found: Found = { legacy: [], loggers: [] };
  for (const dir of ['apps/api/src', 'apps/worker/src']) {
    for (const file of sources(resolve(ROOT, dir))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const at = (node: ts.Node) =>
        `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
      const routeStrings = (node: ts.Node): ts.StringLiteral[] => {
        if (ts.isStringLiteral(node)) return [node];
        if (ts.isObjectLiteralExpression(node)) {
          return node.properties.flatMap((p) =>
            ts.isPropertyAssignment(p) &&
            p.name.getText(source) === 'path' &&
            ts.isStringLiteral(p.initializer)
              ? [p.initializer]
              : [],
          );
        }
        if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(routeStrings);
        return [];
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const name = node.expression.name.text;
          if (name === 'forRoutes') {
            for (const literal of node.arguments.flatMap(routeStrings)) {
              if (LEGACY.has(literal.text))
                found.legacy.push(`${at(literal)} forRoutes('${literal.text}')`);
            }
          }
          if (
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'LoggerModule' &&
            name.startsWith('forRoot')
          ) {
            const text = node.getText(source);
            found.loggers.push({ at: at(node), routes: /\bforRoutes\s*:/.test(text) });
          }
        }
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'forRoutes') {
          for (const literal of routeStrings(node.initializer)) {
            if (LEGACY.has(literal.text))
              found.legacy.push(`${at(literal)} forRoutes: '${literal.text}'`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe('middleware routes', () => {
  const found = scan();

  it('finds the loggers (the probe that cannot fail is the one that never looked)', () => {
    expect(found.loggers.some((l) => l.at.startsWith('apps/api/src/app.module.ts'))).toBe(true);
  });

  it('are never a legacy wildcard', () => {
    expect(found.legacy).toEqual([]);
  });

  it("name the HTTP logger's routes instead of inheriting its bare-wildcard default", () => {
    expect(
      found.loggers.filter((l) => l.at.startsWith('apps/api/') && !l.routes).map((l) => l.at),
    ).toEqual([]);
  });
});
