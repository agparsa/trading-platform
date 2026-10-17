import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEDGER_TYPE_LABEL, ledgerEntries, ledgerLabel } from './ledger';

const entry = (id: string) => ({
  id,
  type: 'DEPOSIT',
  amount: '1.00',
  balanceAfter: '1.00',
  currency: 'USD',
  description: null,
  createdAt: '2026-10-17T08:00:00.000Z',
});

describe('ledger labels', () => {
  it('reads both halves of a closed trade as one thing', () => {
    expect(ledgerLabel('TRADE_PROFIT')).toBe('Closed trade');
    expect(ledgerLabel('TRADE_LOSS')).toBe('Closed trade');
  });

  it('shows a type it does not know as the server spelled it, never nothing', () => {
    expect(ledgerLabel('REBATE')).toBe('REBATE');
  });

  it('names every type the schema has, read from the schema', () => {
    const schema = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prisma/schema.prisma'),
      'utf8',
    );
    const body = /enum LedgerEntryType \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    const types = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    expect(types.length).toBeGreaterThan(0);
    expect(Object.keys(LEDGER_TYPE_LABEL).sort()).toEqual(types.sort());
  });
});

describe('ledgerEntries', () => {
  it('joins the pages in order', () => {
    expect(
      ledgerEntries([{ entries: [entry('c'), entry('b')] }, { entries: [entry('a')] }]).map(
        (row) => row.id,
      ),
    ).toEqual(['c', 'b', 'a']);
  });

  it('shows an entry once when a refetch hands it back on two pages', () => {
    expect(
      ledgerEntries([
        { entries: [entry('d'), entry('c')] },
        { entries: [entry('c'), entry('b')] },
      ]).map((row) => row.id),
    ).toEqual(['d', 'c', 'b']);
  });

  it('is empty before anything has loaded', () => {
    expect(ledgerEntries(undefined)).toEqual([]);
  });
});
