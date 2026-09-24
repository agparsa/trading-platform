import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LIVE_TOPICS, type LiveTopic } from '../apps/mobile/src/lib/live-book';
import { ROOT, clientCalls } from './response-contracts';

/**
 * Every screen on the phone that fetches a list the socket can make stale
 * refetches when it does.
 *
 * The phone subscribed to orders, positions, account and P&L and discarded
 * every frame but quotes, so each of these lists was fetched once and then only
 * when pulled. `LiveProvider` now turns frames into a counter per list
 * (`live-book.ts`); this is what holds the screens to reading it. The calls are
 * found by the same reader `client-routes.test.ts` uses, so a new screen that
 * fetches `/positions` is held to it without being named here.
 */
const STALE_WITH: Readonly<Record<string, LiveTopic>> = {
  'GET /orders/pending': 'orders',
  'GET /positions': 'positions',
  'GET /accounts/*/state': 'account',
  'GET /trades': 'trades',
};

/**
 * The lists whose figures a frame carries, and the function that lays the
 * frame over them. Refetching alone would leave these as they were at the last
 * event: a position's P&L moves on every tick, not on every event.
 */
const MARKED_BY: Readonly<Record<string, string>> = {
  'GET /positions': 'applyPnl',
  'GET /accounts/*/state': 'applyAccount',
};

/** The functions a file calls by name. */
const calledIn = (file: string): Set<string> => {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
};

/** The dependency lists of every `useEffect` in a file, as source text. */
const effectDeps = (file: string): string[][] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[1] !== undefined &&
      ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      found.push(node.arguments[1].elements.map((element) => element.getText(source)));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const phone = clientCalls().calls.filter((call) => call.app === 'mobile' && call.verb === 'GET');

describe('the phone follows the socket', () => {
  it('finds the calls (the probe that cannot fail is the one that never looked)', () => {
    for (const key of Object.keys(STALE_WITH)) {
      expect(phone.some((call) => call.key === key)).toBe(true);
    }
  });

  it('names a list for every counter the socket moves', () => {
    expect([...new Set(Object.values(STALE_WITH))].sort()).toEqual([...LIVE_TOPICS].sort());
  });

  it('refetches each such list when its counter moves', () => {
    const missing = phone
      .filter((call) => STALE_WITH[call.key] !== undefined)
      .filter((call) => {
        const topic = STALE_WITH[call.key]!;
        return !effectDeps(call.file).some((deps) =>
          deps.some((dep) => dep === `versions.${topic}` || dep.endsWith(`.versions.${topic}`)),
        );
      })
      .map(
        (call) =>
          `${call.file}:${call.line} ${call.key} does not refetch on versions.${STALE_WITH[call.key]}`,
      );
    expect(missing).toEqual([]);
  });

  it('lays the live figures over the lists whose figures a frame carries', () => {
    const unmarked = phone
      .filter((call) => MARKED_BY[call.key] !== undefined)
      .filter((call) => !calledIn(call.file).has(MARKED_BY[call.key]!))
      .map((call) => `${call.file}:${call.line} ${call.key} never calls ${MARKED_BY[call.key]}`);
    expect(unmarked).toEqual([]);
  });
});
