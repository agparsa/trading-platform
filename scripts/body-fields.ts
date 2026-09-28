import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Which request-body fields each API route accepts, and which it reads.
 *
 * Used by `body-fields.test.ts`, and runnable alone while a finding is looked
 * into:
 *
 *   npx tsx scripts/body-fields.ts
 *
 * Resolved through the type checker, not by name: two files each declaring a
 * `createSchema` is ordinary, and a name-keyed lookup silently compares a
 * route against somebody else's schema.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Calls that take the body whole without forwarding it anywhere.
 *
 * `idempotent(store, scope, key, body, run)` hashes the body to recognise a
 * repeated request. Counting that as "the body travels" is exactly how
 * `trailingStopDistance` was accepted by POST /orders, fingerprinted, and
 * never handed to the service.
 */
const FINGERPRINTS = new Set(['idempotent']);

export interface Route {
  readonly at: string;
  readonly method: string;
  readonly dto: string;
  /** Keys the schema accepts, or null when it could not be read. */
  readonly accepted: readonly string[] | null;
  /** Keys the handler reads (`body.x`, or destructured). */
  readonly read: readonly string[];
  /** Where the handler hands the body on whole, so every key travels. */
  readonly whole: readonly string[];
}

function program(): ts.Program {
  const configPath = resolve(ROOT, 'apps/api/tsconfig.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return ts.createProgram({
    rootNames: parsed.fileNames.filter((f) => !f.includes('.test.')),
    options: { ...parsed.options, noEmit: true },
  });
}

/** Follow an identifier to the expression it was declared with, across imports. */
function declaredAs(checker: ts.TypeChecker, node: ts.Identifier): ts.Node | null {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.valueDeclaration ?? symbol.declarations?.[0] ?? null;
}

function keysOf(checker: ts.TypeChecker, expression: ts.Expression, depth = 0): string[] | null {
  if (depth > 20) return null;
  if (ts.isParenthesizedExpression(expression))
    return keysOf(checker, expression.expression, depth + 1);
  if (ts.isIdentifier(expression)) {
    const declaration = declaredAs(checker, expression);
    return declaration !== null &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
      ? keysOf(checker, declaration.initializer, depth + 1)
      : null;
  }
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return null;
  }
  const method = expression.expression.name.text;
  const receiver = expression.expression.expression;
  const shapeKeys = (shape: ts.Expression | undefined): string[] | null => {
    if (shape === undefined || !ts.isObjectLiteralExpression(shape)) return null;
    const keys: string[] = [];
    for (const property of shape.properties) {
      if (property.name === undefined) return null; // a spread: not followed
      keys.push(property.name.getText().replace(/^['"]|['"]$/g, ''));
    }
    return keys;
  };

  if (method === 'object' && ts.isIdentifier(receiver) && receiver.text === 'z') {
    return shapeKeys(expression.arguments[0]);
  }
  const inner = keysOf(checker, receiver, depth + 1);
  if (inner === null) return null;
  if (method === 'extend') {
    const more = shapeKeys(expression.arguments[0]);
    return more === null ? null : [...inner, ...more];
  }
  if (method === 'merge') {
    const other = expression.arguments[0];
    const more = other === undefined ? null : keysOf(checker, other, depth + 1);
    return more === null ? null : [...inner, ...more];
  }
  if (method === 'omit' || method === 'pick' || method === 'partial' || method === 'required') {
    // pick/omit change the key set; not modelled, so not guessed.
    return method === 'partial' || method === 'required' ? inner : null;
  }
  // strict, strip, passthrough, refine, superRefine, transform, default, …
  return inner;
}

/**
 * Whether a use of the body is key material for a fingerprint call — the
 * body itself, or the body inside an object literal (`{ id, ...body }`) —
 * rather than something inside the callback the call runs.
 */
function isFingerprint(use: ts.Node): boolean {
  let node: ts.Node = use;
  while (node.parent !== undefined) {
    const parent = node.parent;
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) return false;
    if (ts.isCallExpression(parent)) {
      return (
        ts.isIdentifier(parent.expression) &&
        FINGERPRINTS.has(parent.expression.text) &&
        parent.arguments.some((argument) => argument === node)
      );
    }
    if (
      !ts.isSpreadAssignment(parent) &&
      !ts.isObjectLiteralExpression(parent) &&
      !ts.isShorthandPropertyAssignment(parent) &&
      !ts.isPropertyAssignment(parent)
    ) {
      return false;
    }
    node = parent;
  }
  return false;
}

/** The schema a `class X extends createZodDto(schema)` was built from. */
function schemaOfDto(checker: ts.TypeChecker, type: ts.TypeNode): ts.Expression | null {
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return null;
  const declaration = declaredAs(checker, type.typeName);
  if (declaration === null || !ts.isClassDeclaration(declaration)) return null;
  for (const clause of declaration.heritageClauses ?? []) {
    for (const base of clause.types) {
      const call = base.expression;
      if (
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === 'createZodDto'
      ) {
        return call.arguments[0] ?? null;
      }
    }
  }
  return null;
}

export function scan(): Route[] {
  const built = program();
  const checker = built.getTypeChecker();
  const routes: Route[] = [];

  for (const source of built.getSourceFiles()) {
    if (!source.fileName.endsWith('.controller.ts') || source.fileName.includes('node_modules')) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.body !== undefined) {
        for (const parameter of node.parameters) {
          const isBody = ts
            .getDecorators(parameter)
            ?.some((d) => /^Body\(\s*\)$/.test(d.expression.getText(source)));
          if (!isBody || !ts.isIdentifier(parameter.name) || parameter.type === undefined) continue;
          const name = parameter.name.text;
          const schema = schemaOfDto(checker, parameter.type);
          const accepted = schema === null ? null : keysOf(checker, schema);

          const read = new Set<string>();
          const whole: string[] = [];
          const walk = (inner: ts.Node): void => {
            if (ts.isIdentifier(inner) && inner.text === name && inner !== parameter.name) {
              const parent = inner.parent;
              if (ts.isPropertyAccessExpression(parent) && parent.expression === inner) {
                read.add(parent.name.text);
              } else if (
                ts.isVariableDeclaration(parent) &&
                ts.isObjectBindingPattern(parent.name) &&
                parent.initializer === inner
              ) {
                for (const element of parent.name.elements) {
                  if (element.dotDotDotToken !== undefined) whole.push('...rest');
                  else read.add((element.propertyName ?? element.name).getText(source));
                }
              } else if (isFingerprint(inner)) {
                // Hashed for idempotency, not forwarded.
              } else {
                const call = ts.findAncestor(parent, ts.isCallExpression);
                whole.push(
                  call === undefined ? parent.getText(source) : call.expression.getText(source),
                );
              }
            }
            ts.forEachChild(inner, walk);
          };
          walk(node.body);

          routes.push({
            at: `${relative(ROOT, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            method: node.name.getText(source),
            dto: parameter.type.getText(source),
            accepted,
            read: [...read],
            whole,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return routes;
}

/** Keys a route accepts and never reads, when it does not hand the body on whole. */
export function dropped(route: Route): string[] {
  if (route.accepted === null || route.whole.length > 0) return [];
  return route.accepted.filter((key) => !route.read.includes(key));
}

if (process.argv[1]?.endsWith('body-fields.ts') === true) {
  const routes = scan();
  for (const route of routes) {
    if (route.accepted === null) {
      console.log(`?  ${route.at} ${route.method}(${route.dto}) — schema not read`);
    } else if (route.whole.length > 0) {
      console.log(
        `=  ${route.at} ${route.method}(${route.dto}) — whole into ${route.whole.join(', ')}`,
      );
    } else {
      const missing = dropped(route);
      if (missing.length > 0)
        console.log(`!  ${route.at} ${route.method}(${route.dto}) drops: ${missing.join(', ')}`);
    }
  }
  console.log(`${routes.length} routes with a body`);
}
