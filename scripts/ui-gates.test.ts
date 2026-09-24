import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Permission } from '@tp/shared-types';
import { routePermissions } from './api-inventory';
import { COMPUTED_PATHS, ROOT, clientCalls } from './response-contracts';

/**
 * Every administrative action is offered only to the people its route serves.
 *
 * The server decides, always: a missing capability is a 403 whatever the
 * screen shows. But on 24 September sixteen admin screens offered their
 * actions to anybody who could open them — Approve in the withdrawal queue to
 * administrators, whose role does not review withdrawals; the kill switch to
 * support — and the refusal was the first an operator learned of it. One screen
 * gated its button on a capability its route does not ask for, offering it to
 * the wrong people and hiding it from the right ones.
 *
 * So each mutation hook in `lib/admin-queries.ts` carries a gate naming a
 * capability, and this test holds two things:
 *
 * - the capability a hook names is exactly what the route it calls requires,
 *   read from the controllers (`routePermissions`);
 * - every control that fires a gated hook is given its gate (`gate={hook}`,
 *   any `…Gate={hook}` prop that carries it, or `hook.allowed` read directly).
 */
const QUERIES = 'apps/web/src/lib/admin-queries.ts';
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const VALUE_OF = Permission as Readonly<Record<string, string>>;

const routes = new Map(
  routePermissions().map((route) => [
    `${route.verb} ${route.path.replace(/:[A-Za-z]+/g, '*')}`,
    route.permissions.map((name) => VALUE_OF[name] ?? name),
  ]),
);

interface Hook {
  name: string;
  text: string;
  /** Capabilities the routes it calls require. */
  required: Set<string>;
  /** Capabilities it names. */
  named: Set<string>;
  gated: boolean;
}

function hooks(): Hook[] {
  const source = ts.createSourceFile(QUERIES, read(QUERIES), ts.ScriptTarget.Latest, true);
  const calls = clientCalls().calls.filter((call) => call.file === QUERIES);
  const found: Hook[] = [];
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    const text = statement.getText(source);
    const start = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const end = source.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
    const mine = calls.filter((call) => call.line >= start && call.line <= end);
    const mutates = /useMutation\(|use(Kyc|Withdrawal)Action</.test(text);
    if (!mutates || mine.length === 0) continue;
    const required = new Set<string>();
    for (const call of mine) {
      for (const key of COMPUTED_PATHS[call.key] ?? [call.key]) {
        for (const permission of routes.get(key) ?? [`(no route ${key})`]) required.add(permission);
      }
    }
    const named = new Set(
      [...text.matchAll(/Permission\.([A-Z_]+)/g)].map((match) => VALUE_OF[match[1]!] ?? match[1]!),
    );
    found.push({
      name: statement.name.text,
      text,
      required,
      named,
      gated: /useGated\(|use(Kyc|Withdrawal)Action</.test(text),
    });
  }
  return found;
}

const all = hooks();

describe('each admin mutation hook names the capability its route requires', () => {
  it('finds them (the probe that cannot fail is the one that never looked)', () => {
    expect(all.length).toBeGreaterThan(40);
    expect(all.map((hook) => hook.name)).toEqual(
      expect.arrayContaining(['useHaltTrading', 'useDecideWithdrawal', 'useResolveUnconfirmed']),
    );
  });

  it('gates every one', () => {
    expect(all.filter((hook) => !hook.gated).map((hook) => hook.name)).toEqual([]);
  });

  it('names exactly what the routes require', () => {
    const wrong = all
      .filter(
        (hook) =>
          hook.required.size !== hook.named.size ||
          [...hook.required].some((permission) => !hook.named.has(permission)),
      )
      .map(
        (hook) =>
          `${hook.name}: names ${[...hook.named].join(', ')}; routes require ${[...hook.required].join(', ')}`,
      );
    expect(wrong).toEqual([]);
  });
});

function screens(): string[] {
  return ['apps/web/src/components/admin', 'apps/web/src/app/admin'].flatMap((directory) =>
    ts.sys
      .readDirectory(join(ROOT, directory), ['.tsx'])
      .filter((file) => !/\.test\.tsx$/.test(file))
      .map((file) => relative(ROOT, file)),
  );
}

describe('every control that fires one is given its gate', () => {
  const names = new Set(all.map((hook) => hook.name));

  it('reads the screens', () => {
    expect(screens().length).toBeGreaterThan(20);
  });

  it('passes the gate wherever the hook is fired', () => {
    const ungated: string[] = [];
    for (const file of screens()) {
      const text = read(file);
      for (const match of text.matchAll(/const (\w+) = (use[A-Z]\w*)\(/g)) {
        const [, variable, hook] = match as unknown as [string, string, string];
        if (!names.has(hook)) continue;
        if (!new RegExp(`\\b${variable}\\.mutate(Async)?\\(`).test(text)) continue;
        const gated =
          new RegExp(`\\b\\w*[gG]ate=\\{${variable}\\}`).test(text) ||
          new RegExp(`\\b${variable}\\.allowed\\b`).test(text);
        if (!gated) ungated.push(`${file}: ${variable} = ${hook}()`);
      }
    }
    expect(ungated).toEqual([]);
  });

  it('reads no capability by its string, where a hook already names it', () => {
    // `includes('orders.modify')` is how the venue-recovery screen came to ask
    // for the wrong one. A screen asks its hook instead — so no screen spells
    // a capability at all, however it would go on to use it.
    const capabilities = new Set(Object.values(VALUE_OF));
    const literal: string[] = [];
    for (const file of screens()) {
      // String literals and `Permission.X` in code; not comments, not the
      // words on the screen, which may name a capability to explain it.
      const source = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          capabilities.has(node.text)
        ) {
          literal.push(`${file}: '${node.text}'`);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.getText(source) === 'Permission'
        ) {
          literal.push(`${file}: ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(literal).toEqual([]);
  });
});
