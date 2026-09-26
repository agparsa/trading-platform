import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@tp/shared-types';
import {
  allowedOrderTransitions,
  canTransitionOrder,
} from '../packages/trading-core/src/state/order-state-machine';

/**
 * Every order status the code writes is a move the state machine allows, and
 * every such move is in the order's event trail.
 *
 * `docs/order-lifecycle.md` said nothing assigns `order.status` directly and
 * every change goes through `transitionOrder`. Most writes did not: a cancel's
 * and a modify's claims, every move on the venue path, three order creations.
 * All of them happened to be legal moves. None was checked. And the trail the
 * same page calls a complete record had gaps: a modify's PENDING →
 * MODIFY_REQUESTED was written to the order and never to its events, and a
 * resting order refused at its fill showed TRIGGERED → REJECTED without the
 * PENDING → TRIGGERED before it.
 *
 * So the writes are read from the source. For each `order.create / update /
 * updateMany` that sets a status, the prior status is what the write is
 * conditional on (`where.status`) or what it names (`transitionOrder(from,
 * to)`); for each `orderEvent` row, its `fromStatus` and `toStatus`. A value
 * this reader cannot name fails, so a new write cannot pass by computing its
 * status. A status taken from the enclosing function's parameters is followed
 * to each call of that function in the file, and belongs to the caller: a
 * helper that records an event records it for whoever called it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['apps/api/src', 'apps/worker/src'];
const STATUSES = new Set<string>(Object.values(OrderStatus));
/** No prior status: the row an order is created with. */
const NONE = '∅';

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

type Named = ts.MethodDeclaration | ts.FunctionDeclaration;
interface Binding {
  readonly expr: ts.Expression | undefined;
  readonly fn: Named | null;
  readonly env: Env | null;
}
type Env = ReadonlyMap<string, Binding>;

interface Site {
  /** `file:function` the move belongs to. */
  readonly owner: string;
  /** `file:line`. */
  readonly at: string;
}
interface Move extends Site {
  readonly from: string;
  readonly to: string;
}
interface Unread extends Site {
  readonly what: string;
}

interface Found {
  readonly writes: Move[];
  readonly events: Move[];
  /** Rows written together by one `createMany`, in order. */
  readonly batches: Move[][];
  readonly unread: Unread[];
}

const nameOf = (fn: Named): string | null => fn.name?.getText() ?? null;

const named = (node: ts.Node): Named | null => {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name !== undefined) {
      return at;
    }
  }
  return null;
};

const prop = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
};

export function scan(): Found {
  const found: Found = { writes: [], events: [], batches: [], unread: [] };

  for (const dir of DIRS) {
    for (const file of sources(resolve(ROOT, dir))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const path = relative(ROOT, file);
      const line = (node: ts.Node) =>
        `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

      /** Every call in this file, by the name it calls. */
      const calls = new Map<string, ts.CallExpression[]>();
      const collect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) &&
                callee.expression.kind === ts.SyntaxKind.ThisKeyword
              ? callee.name.text
              : null;
          if (name !== null) calls.set(name, [...(calls.get(name) ?? []), node]);
        }
        ts.forEachChild(node, collect);
      };
      collect(source);

      /**
       * The statuses an expression can be, where `env` binds the enclosing
       * function's parameters for one chain of calls into it. `null`: not
       * readable.
       */
      const values = (
        expr: ts.Expression | undefined,
        fn: Named | null,
        env: Env | null,
        depth = 0,
      ): Set<string> | null => {
        if (expr === undefined || depth > 8) return null;
        if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
          return values(expr.expression, fn, env, depth);
        }
        if (ts.isStringLiteral(expr)) return STATUSES.has(expr.text) ? new Set([expr.text]) : null;
        if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'OrderStatus'
        ) {
          return STATUSES.has(expr.name.text) ? new Set([expr.name.text]) : null;
        }
        if (
          ts.isCallExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'transitionOrder'
        ) {
          return values(expr.arguments[1], fn, env, depth);
        }
        if (ts.isConditionalExpression(expr)) {
          const a = values(expr.whenTrue, fn, env, depth);
          const b = values(expr.whenFalse, fn, env, depth);
          return a === null || b === null ? null : new Set([...a, ...b]);
        }
        if (ts.isIdentifier(expr) && fn !== null) {
          const bound = env?.get(expr.text);
          if (bound !== undefined) return values(bound.expr, bound.fn, bound.env, depth + 1);
          const parameter = fn.parameters.find((p) => p.name.getText() === expr.text);
          if (parameter !== undefined) return values(parameter.initializer, fn, null, depth + 1);
          let local: ts.Expression | undefined;
          const find = (node: ts.Node): void => {
            if (
              ts.isVariableDeclaration(node) &&
              node.name.getText() === expr.text &&
              node.initializer !== undefined
            ) {
              local = node.initializer;
            }
            ts.forEachChild(node, find);
          };
          if (fn.body !== undefined) find(fn.body);
          return local === undefined ? null : values(local, fn, env, depth + 1);
        }
        return null;
      };

      /** Which of `fn`'s parameters the expressions read. */
      const parametersUsed = (fn: Named, exprs: readonly (ts.Expression | undefined)[]) => {
        const parameters = new Set(fn.parameters.map((p) => p.name.getText()));
        const used = new Set<string>();
        const look = (at: ts.Node): void => {
          if (ts.isIdentifier(at) && parameters.has(at.text)) used.add(at.text);
          ts.forEachChild(at, look);
        };
        for (const expr of exprs) if (expr !== undefined) look(expr);
        return used;
      };

      /**
       * One reading of a move per chain of calls that binds what it depends
       * on, owned by the function at the top of the chain: a status taken from
       * a parameter belongs to whoever passed it.
       */
      const expand = (
        fn: Named | null,
        exprs: readonly (ts.Expression | undefined)[],
        depth = 0,
      ): Array<{ owner: string; env: Env | null }> => {
        const own = [{ owner: `${path}:${fn === null ? '(top)' : nameOf(fn)}`, env: null }];
        if (fn === null || depth > 4) return own;
        const used = parametersUsed(fn, exprs);
        const sites = calls.get(nameOf(fn) ?? '') ?? [];
        if (used.size === 0 || sites.length === 0) return own;
        return sites.flatMap((site) => {
          const caller = named(site);
          const bound = fn.parameters.map((p, i) => site.arguments[i] ?? p.initializer);
          const onward = fn.parameters.flatMap((p, i) =>
            used.has(p.name.getText()) ? [bound[i]] : [],
          );
          return expand(caller, onward, depth + 1).map((outer) => ({
            owner: outer.owner,
            env: new Map(
              fn.parameters.map((p, i) => [
                p.name.getText(),
                { expr: bound[i], fn: caller, env: outer.env },
              ]),
            ) as Env,
          }));
        });
      };
      const readings = (node: ts.Node, exprs: readonly (ts.Expression | undefined)[]) => {
        const fn = named(node);
        return expand(fn, exprs).map((reading) => ({ ...reading, fn }));
      };

      const product = (from: Set<string>, to: Set<string>) =>
        [...from].flatMap((f) => [...to].map((t) => ({ from: f, to: t })));

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression)
        ) {
          const model = node.expression.expression.name.text;
          const method = node.expression.name.text;
          const argument = node.arguments[0];
          const data =
            argument !== undefined && ts.isObjectLiteralExpression(argument)
              ? prop(argument, 'data')
              : undefined;

          if (model === 'order' && ['create', 'update', 'updateMany', 'upsert'].includes(method)) {
            const status =
              data !== undefined && ts.isObjectLiteralExpression(data)
                ? prop(data, 'status')
                : undefined;
            if (status !== undefined) {
              const where = prop(argument as ts.ObjectLiteralExpression, 'where');
              const condition =
                where !== undefined && ts.isObjectLiteralExpression(where)
                  ? prop(where, 'status')
                  : undefined;
              const named =
                ts.isCallExpression(status) &&
                ts.isIdentifier(status.expression) &&
                status.expression.text === 'transitionOrder'
                  ? status.arguments[0]
                  : undefined;
              for (const reading of readings(node, [status, condition, named])) {
                const to = values(status, reading.fn, reading.env);
                const from =
                  method === 'create'
                    ? new Set([NONE])
                    : (values(condition, reading.fn, reading.env) ??
                      values(named, reading.fn, reading.env));
                if (to === null || from === null) {
                  found.unread.push({
                    owner: reading.owner,
                    at: line(node),
                    what: `order.${method} status=${status.getText(source)} where.status=${condition?.getText(source) ?? '(none)'}`,
                  });
                  continue;
                }
                // A write that says its prior status twice must say one thing.
                const stated = values(named, reading.fn, reading.env);
                if (
                  condition !== undefined &&
                  stated !== null &&
                  [...stated].some((one) => !from.has(one))
                ) {
                  found.unread.push({
                    owner: reading.owner,
                    at: line(node),
                    what: `order.${method} is conditional on ${[...from].join('|')} and names ${[...stated].join('|')}`,
                  });
                  continue;
                }
                for (const move of product(from, to)) {
                  found.writes.push({ ...move, owner: reading.owner, at: line(node) });
                }
              }
            }
          }

          if (model === 'orderEvent' && (method === 'create' || method === 'createMany')) {
            const rows =
              data === undefined
                ? []
                : ts.isArrayLiteralExpression(data)
                  ? [...data.elements]
                  : [data];
            if (rows.length === 0 || !rows.every(ts.isObjectLiteralExpression)) {
              found.unread.push({
                owner: `${path}`,
                at: line(node),
                what: `orderEvent.${method} with rows this reader cannot see`,
              });
            } else {
              const exprs = rows.flatMap((row) => [prop(row, 'fromStatus'), prop(row, 'toStatus')]);
              for (const reading of readings(node, exprs)) {
                const batch: Move[] = [];
                for (const row of rows) {
                  const fromExpr = prop(row, 'fromStatus');
                  const from =
                    fromExpr === undefined
                      ? new Set([NONE])
                      : values(fromExpr, reading.fn, reading.env);
                  const to = values(prop(row, 'toStatus'), reading.fn, reading.env);
                  if (from === null || to === null) {
                    found.unread.push({
                      owner: reading.owner,
                      at: line(row),
                      what: `event ${fromExpr?.getText(source) ?? NONE} → ${prop(row, 'toStatus')?.getText(source) ?? '?'}`,
                    });
                    continue;
                  }
                  for (const move of product(from, to)) {
                    const recorded = { ...move, owner: reading.owner, at: line(row) };
                    found.events.push(recorded);
                    batch.push(recorded);
                  }
                }
                if (rows.length > 1) found.batches.push(batch);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

const found = scan();
const legal = (move: Move) =>
  move.from === NONE
    ? move.to === OrderStatus.NEW
    : canTransitionOrder(move.from as OrderStatus, move.to as OrderStatus);
const show = (move: Move) =>
  `${move.at} (${move.owner.split(':').pop()}) ${move.from} → ${move.to}`;

describe('order status writes', () => {
  it('are found (the probe that cannot fail is the one that never looked)', () => {
    const owners = new Set(found.writes.map((w) => w.owner.split(':').pop()));
    for (const expected of ['fillPending', 'cancelPending', 'modifyPending', 'expirePending']) {
      expect(owners.has(expected), expected).toBe(true);
    }
    // The venue path's statuses come through a parameter and a helper.
    expect(found.writes.some((w) => w.from === 'UNCONFIRMED' && w.to === 'FILLED')).toBe(true);
    expect(found.events.some((e) => e.from === 'ACCEPTED' && e.to === 'UNCONFIRMED')).toBe(true);
  });

  it('name every status they write and the status they write it over', () => {
    expect(found.unread.map((u) => `${u.at} ${u.what}`)).toEqual([]);
  });

  it('are each a move the state machine allows', () => {
    const illegal = found.writes
      .filter((w) => w.from !== NONE)
      .filter((w) => !legal(w))
      .map(show);
    expect(illegal).toEqual([]);
  });

  it('are each recorded in the trail, by the code that makes them', () => {
    const recorded = new Set(found.events.map((e) => `${e.owner} ${e.from}>${e.to}`));
    const missing = found.writes
      .filter((w) => w.from !== NONE)
      .filter((w) => !recorded.has(`${w.owner} ${w.from}>${w.to}`))
      .map(show);
    expect(missing).toEqual([]);
  });

  it('create an order only with the trail that leads to the status it is created in', () => {
    const missing = found.writes
      .filter((w) => w.from === NONE)
      .filter((w) => {
        const chain = found.batches.find(
          (batch) =>
            batch[0]?.owner === w.owner && batch[0]?.from === NONE && batch.at(-1)?.to === w.to,
        );
        return chain === undefined;
      })
      .map(show);
    expect(missing).toEqual([]);
  });
});

describe('the order trail', () => {
  it('holds only moves the state machine allows, starting from NEW', () => {
    expect(found.events.filter((e) => !legal(e)).map(show)).toEqual([]);
  });

  it('writes each batch as an unbroken chain', () => {
    const broken = found.batches
      .filter((batch) => batch.some((move, i) => i > 0 && batch[i - 1]!.to !== move.from))
      .map((batch) => batch.map(show).join(' | '));
    expect(broken).toEqual([]);
  });
});

describe('docs/order-lifecycle.md', () => {
  const doc = readFileSync(resolve(ROOT, 'docs/order-lifecycle.md'), 'utf8');

  it('lists every transition the state machine allows, and no other', () => {
    const start = doc.indexOf('| From');
    const rows = doc.slice(start, doc.indexOf('\n\n', start)).split('\n').slice(2);
    const documented = rows
      .flatMap((row) => {
        const [from = '', to = ''] = row
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim());
        const source = /`([A-Z_]+)`/.exec(from)?.[1];
        return [...to.matchAll(/`([A-Z_]+)`/g)].map((m) => `${source}>${m[1]}`);
      })
      .sort();
    const machine = Object.values(OrderStatus)
      .flatMap((from) => allowedOrderTransitions(from).map((to) => `${from}>${to}`))
      .sort();
    expect(documented).toEqual(machine);
  });
});
