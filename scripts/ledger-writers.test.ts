import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Each ledger has the writers `docs/wallet.md` names, and no others.
 *
 * The page's table said `LedgerService` was the only writer of
 * `balance_ledger` and `accounts.balance`. The worker's nightly swap accrual
 * was a second — it cannot reach the API's service — and it had its own copy
 * of the posting, including the bug `LedgerService` had been fixed for:
 * storing the amount rounded and rounding the new balance separately, so an
 * accrual that is not a whole cent (0.15 lots at −12.50) wrote −1.88 to the
 * ledger and moved the balance by −1.87. A second writer is a second place
 * for a rule to be fixed in one and not the other; this makes the set of them
 * a decision somebody writes down.
 *
 * Found from the source: every Prisma write to a ledger table, and every
 * write to an account or wallet whose data sets `balance`. Raw SQL that
 * updates either balance fails too.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['apps/api/src', 'apps/worker/src', 'apps/api-ws/src', 'apps/api-ingest/src'];

const WRITERS: Readonly<Record<string, readonly string[]>> = {
  balanceLedger: [
    'apps/api/src/accounts/ledger.service.ts',
    // The worker has no LedgerService. Same rule, same test: jobs.test.ts,
    // "moves the balance by exactly the amount it records".
    'apps/worker/src/jobs/swap-accrual.service.ts',
  ],
  'account.balance': [
    'apps/api/src/accounts/ledger.service.ts',
    'apps/worker/src/jobs/swap-accrual.service.ts',
  ],
  walletTransaction: ['apps/api/src/wallet/wallet.service.ts'],
  'wallet.balance': ['apps/api/src/wallet/wallet.service.ts'],
};

const WRITES = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

const sources = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
    });
  } catch {
    return [];
  }
};

const setsBalance = (arg: ts.Expression | undefined): boolean => {
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ['data', 'create', 'update'].includes(p.name.getText()) &&
      ts.isObjectLiteralExpression(p.initializer) &&
      p.initializer.properties.some(
        (q) =>
          q.name?.getText() === 'balance' &&
          // Opening a row at zero moves no money; the opening balance, if
          // any, is a ledger posting like every other.
          !(ts.isPropertyAssignment(q) && /^['"]0['"]$/.test(q.initializer.getText())),
      ),
  );
};

function writers(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (what: string, file: string) =>
    found.set(what, new Set([...(found.get(what) ?? []), file]));
  for (const dir of DIRS) {
    for (const file of sources(resolve(ROOT, dir))) {
      const path = relative(ROOT, file);
      const text = readFileSync(file, 'utf8');
      if (/UPDATE\s+"?(accounts|wallets)"?\s+SET\s+"?balance/i.test(text)) add('raw SQL', path);
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          WRITES.has(node.expression.name.text)
        ) {
          const model = node.expression.expression.name.text;
          if (model === 'balanceLedger' || model === 'walletTransaction') add(model, path);
          if ((model === 'account' || model === 'wallet') && setsBalance(node.arguments[0])) {
            add(`${model}.balance`, path);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe('who writes a ledger', () => {
  const found = writers();

  it('finds them (the probe that cannot fail is the one that never looked)', () => {
    expect([...(found.get('balanceLedger') ?? [])]).toContain(
      'apps/api/src/accounts/ledger.service.ts',
    );
  });

  it('is exactly who docs/wallet.md and this file say', () => {
    const actual = Object.fromEntries(
      [...found.entries()].map(([what, files]) => [what, [...files].sort()]),
    );
    const expected = Object.fromEntries(
      Object.entries(WRITERS).map(([what, files]) => [what, [...files].sort()]),
    );
    expect(actual).toEqual(expected);
  });

  it('are named in docs/wallet.md', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/wallet.md'), 'utf8');
    for (const file of new Set(Object.values(WRITERS).flat())) {
      expect(doc, file).toContain(file.split('/').pop()!);
    }
  });
});
