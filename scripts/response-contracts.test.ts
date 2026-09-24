import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ROOT,
  type Mismatch,
  type Sample,
  type TypedCall,
  checkSamples,
  literalType,
  typedCalls,
} from './response-contracts';
import { COMPUTED, MAY_BE_EMPTY, SKIPPED } from './smoke-contracts';

/**
 * The reader and the comparer behind `pnpm smoke:contracts`, without a
 * running API.
 *
 * The smoke run needs a database, a built API and a worker, so it runs in CI
 * after the build and not in `pnpm test`. What can be proved without them is
 * proved here: that the reader finds the calls (including the two it was
 * written to find), that the comparer rejects each kind of wrong answer — a
 * missing field, a wrong type, a value outside a union, a bad row deep in a
 * list — and accepts a right one with extra fields, and that the smoke run
 * accounts for every typed call a client makes, so a new screen cannot add a
 * call the run silently never makes.
 */
const calls = typedCalls();
const find = (app: TypedCall['app'], key: string): TypedCall => {
  const call = calls.find((candidate) => candidate.app === app && candidate.key === key);
  if (call === undefined) throw new Error(`no ${app} call ${key}`);
  return call;
};

describe('the reader', () => {
  it('finds the typed calls of every client (the probe that cannot fail is the one that never looked)', () => {
    expect(calls.length).toBeGreaterThan(150);
    for (const app of ['web', 'mobile', 'chart-core'] as const) {
      expect(calls.some((call) => call.app === app)).toBe(true);
    }
  });

  it("reads the phone's positions call with the account it must name", () => {
    // The request that was refused on every open of the tab, until it named one.
    expect(find('mobile', 'GET /positions').query).toHaveProperty('accountId');
  });

  it('reads query keys, literal values, and both branches of a conditional path', () => {
    expect(find('web', 'GET /admin/webhooks/*/deliveries').query).toEqual({ limit: '100' });
    const kyc = calls.filter((call) => call.key === 'GET /admin/kyc');
    expect(kyc.map((call) => call.query)).toEqual([{}, { status: null }]);
  });

  it('keeps the type argument exactly as written', () => {
    expect(find('mobile', 'GET /accounts/*/state').typeText).toBe('AccountState');
    expect(find('web', 'GET /operations/summary').typeText).toBe('OperationsSummary');
  });
});

describe('literalType', () => {
  it('turns every leaf into its literal type', () => {
    expect(literalType({ a: 'x', b: 1, c: true, d: null, e: [1, 'y'] })).toBe(
      '{ "a": "x"; "b": 1; "c": true; "d": null; "e": [1, "y"] }',
    );
  });

  it('quotes keys and strings so that no answer can break out of the type', () => {
    expect(literalType({ 'a"b': 'line\nbreak "quoted"' })).toBe(
      '{ "a\\"b": "line\\nbreak \\"quoted\\"" }',
    );
  });
});

describe('the comparer', () => {
  const summary = {
    trading: { state: 'TRADING_ENABLED', reason: null, changedAt: null, changedByUserId: null },
    accounts: { total: 3, active: 3, withOpenPositions: 1 },
    positions: { open: 1 },
    orders: { resting: 0, lastHour: 2, rejectedLastHour: 0 },
    risk: { eventsLastDay: 0, criticalLastDay: 0 },
    integrity: { open: 0, bySeverity: {} },
    money: { byCurrency: [] },
    reconciliation: { openFindings: 0, lastRunAt: null },
    takenAt: '2026-09-24T10:00:00.000Z',
  };
  const state = {
    accountId: 'a',
    currency: 'USD',
    balance: '100.00',
    equity: '100.00',
    usedMargin: '0.00',
    freeMargin: '100.00',
    marginLevel: null,
    floatingPnl: '0.00',
    realizedPnlToday: '0.00',
    realizedPnlTotal: '0.00',
    realizedSince: 1,
    updatedAt: 2,
    // Sent by the server, not read by the phone: allowed.
    grossExposure: '0.00',
  };
  const position = {
    id: 'p',
    symbol: 'EURUSD',
    side: 'BUY',
    volume: '0.10',
    entryPrice: '1.1',
    currentPrice: '1.2',
    stopLoss: null,
    takeProfit: null,
    floatingPnl: '1.00',
    netFloatingPnl: '0.65',
    stale: false,
    openedAt: '2026-09-24T10:00:00.000Z',
  };

  const cases: Array<{ name: string; sample: Sample; wrong: RegExp | null }> = [];
  const add = (name: string, call: TypedCall, data: unknown, wrong: RegExp | null) =>
    cases.push({ name, sample: { call, data }, wrong });

  {
    const ops = find('web', 'GET /operations/summary');
    const home = find('mobile', 'GET /accounts/*/state');
    const book = find('mobile', 'GET /positions');
    add('the kill switch as the server sends it', ops, summary, null);
    add(
      'the kill switch as the console used to read it',
      ops,
      { ...summary, trading: { halted: true, reason: null } },
      /state/,
    );
    add('the home figures the server sends', home, state, null);
    add(
      'the home figures the phone used to read',
      home,
      { ...state, realizedPnlToday: undefined, realizedPnlTotal: undefined },
      /realizedPnlToday/,
    );
    add('a string where a number is read', home, { ...state, updatedAt: '2' }, /updatedAt/);
    add('null where a value is read', home, { ...state, equity: null }, /equity/);
    add('a book of positions', book, [position, { ...position, id: 'q', stale: null }], null);
    add(
      'a side outside the union, in the second row',
      book,
      [position, { ...position, id: 'q', side: 'LONG' }],
      /LONG/,
    );
  }

  let mismatches: Mismatch[] = [];
  beforeAll(() => {
    // One compiler program per app for every case: this is the slow part.
    mismatches = checkSamples(cases.map((c) => c.sample));
  }, 120_000);

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const messages = mismatches.filter((m) => m.sample === c.sample).map((m) => m.message);
    if (c.wrong === null) expect(messages).toEqual([]);
    else expect(messages.join('\n')).toMatch(c.wrong);
  });
});

describe('the smoke run accounts for every typed call', () => {
  const smoke = readFileSync(join(ROOT, 'scripts/smoke-contracts.ts'), 'utf8');

  it('makes, records or skips each one — a new screen cannot add a call it never makes', () => {
    const unaccounted = calls
      .filter((call) => call.verb !== 'GET' || call.path.includes('*'))
      .filter(
        (call) =>
          SKIPPED[call.key] === undefined &&
          COMPUTED[call.key] === undefined &&
          !smoke.includes(`'${call.key}'`),
      )
      .map((call) => `${call.key}  (${call.file}:${call.line})`);
    expect(unaccounted).toEqual([]);
  });

  it('lists nothing in its exemptions that no client calls', () => {
    const keys = new Set(calls.map((call) => call.key));
    expect(Object.keys(SKIPPED).filter((key) => !keys.has(key))).toEqual([]);
    expect(Object.keys(MAY_BE_EMPTY).filter((key) => !keys.has(key))).toEqual([]);
    expect(Object.keys(COMPUTED).filter((key) => !keys.has(key))).toEqual([]);
  });
});
