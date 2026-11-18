import { describe, expect, it } from 'vitest';
import {
  dayNumber,
  evaluateChallenge,
  termsProblem,
  type ChallengeFigures,
  type ChallengeTerms,
} from './challenge-rules';

const terms: ChallengeTerms = {
  profitTargetPct: '8',
  dailyLossPct: '5',
  maxLossPct: '10',
  drawdownMode: 'STATIC',
  trailingLock: false,
  dailyBasis: 'BALANCE',
  minTradingDays: 5,
  maxDays: 30,
};

const fresh: ChallengeFigures = {
  initialBalance: '100000',
  dayStartBalance: '100000',
  dayStartEquity: '100000',
  highWaterEquity: '100000',
  balance: '100000',
  equity: '100000',
  openPositions: 0,
  tradingDays: 0,
  dayNumber: 1,
};

const at = (over: Partial<ChallengeFigures>, t: Partial<ChallengeTerms> = {}) =>
  evaluateChallenge({ ...terms, ...t }, { ...fresh, ...over });

describe('daily loss', () => {
  it('breaks at exactly the floor, not a cent before', () => {
    expect(at({ equity: '95000.01' }).kind).toBe('ONGOING');
    const hit = at({ equity: '95000' });
    expect(hit).toMatchObject({ kind: 'BREACHED', rule: 'DAILY_LOSS' });
    expect(hit.metrics.dailyLossLimit).toBe('5000');
    expect(hit.metrics.dailyFloor).toBe('95000');
  });

  it('counts floating loss: equity, not balance', () => {
    expect(at({ balance: '100000', equity: '94720', openPositions: 1 })).toMatchObject({
      kind: 'BREACHED',
      rule: 'DAILY_LOSS',
    });
  });

  it('measures from the reference the plan chose', () => {
    const day = { dayStartBalance: '100000', dayStartEquity: '102000', equity: '96500' };
    expect(at(day, { dailyBasis: 'BALANCE' }).kind).toBe('ONGOING');
    // 5% of 102,000 is 5,100; the floor is 96,900.
    expect(at(day, { dailyBasis: 'EQUITY' })).toMatchObject({ rule: 'DAILY_LOSS' });
    expect(at(day, { dailyBasis: 'HIGHER' }).metrics.dailyReference).toBe('102000');
  });

  it('starts each day from that day’s figures, not the phase’s', () => {
    expect(
      at({ dayStartBalance: '106000', dayStartEquity: '106000', equity: '100700' }),
    ).toMatchObject({
      kind: 'BREACHED',
      rule: 'DAILY_LOSS',
    });
  });
});

describe('maximum loss', () => {
  it('holds a static floor below the initial balance', () => {
    const day = { dayStartBalance: '91000', dayStartEquity: '91000' };
    expect(at({ ...day, equity: '90000.01' }).kind).toBe('ONGOING');
    expect(at({ ...day, equity: '90000' })).toMatchObject({ rule: 'MAX_LOSS' });
  });

  it('trails the high-water equity', () => {
    const t = { drawdownMode: 'TRAILING' as const };
    const day = { dayStartBalance: '110000', dayStartEquity: '110000' };
    const v = at(
      { ...day, highWaterEquity: '112000', equity: '106000' },
      { ...t, dailyLossPct: '9' },
    );
    expect(v.metrics.maxLossFloor).toBe('102000');
    expect(
      at({ ...day, highWaterEquity: '112000', equity: '102000' }, { ...t, dailyLossPct: '9' }),
    ).toMatchObject({
      rule: 'MAX_LOSS',
    });
  });

  it('stops a locked trailing floor at the initial balance', () => {
    const v = at(
      {
        highWaterEquity: '130000',
        equity: '125000',
        balance: '125000',
        dayStartBalance: '125000',
        dayStartEquity: '125000',
      },
      { drawdownMode: 'TRAILING', trailingLock: true, profitTargetPct: '50' },
    );
    expect(v.metrics.maxLossFloor).toBe('100000');
  });

  it('raises high water with the equity it is shown', () => {
    expect(
      at({ equity: '101000', balance: '100000', openPositions: 1 }).metrics.highWaterEquity,
    ).toBe('101000');
  });
});

describe('passing', () => {
  const passing = {
    balance: '108000',
    equity: '108000',
    dayStartBalance: '107000',
    dayStartEquity: '107000',
    tradingDays: 5,
  };

  it('passes on closed profit with enough trading days and nothing open', () => {
    const v = at(passing);
    expect(v.kind).toBe('PASSED');
    expect(v.metrics.targetBalance).toBe('108000');
    expect(v.metrics.targetProgressPct).toBe('100.00');
  });

  it('does not pass on floating profit', () => {
    expect(at({ ...passing, balance: '104000', equity: '109000', openPositions: 1 }).kind).toBe(
      'ONGOING',
    );
    expect(at({ ...passing, openPositions: 1 }).kind).toBe('ONGOING');
  });

  it('waits for the minimum trading days', () => {
    expect(at({ ...passing, tradingDays: 4 }).kind).toBe('ONGOING');
  });

  it('reports progress toward the target, never below zero', () => {
    expect(
      at({
        balance: '104000',
        equity: '104000',
        dayStartBalance: '104000',
        dayStartEquity: '104000',
      }).metrics.targetProgressPct,
    ).toBe('50.00');
    expect(at({ balance: '99000', equity: '99000' }).metrics.targetProgressPct).toBe('0.00');
  });

  it('puts a breach before a pass', () => {
    expect(at({ ...passing, dayStartBalance: '120000', dayStartEquity: '120000' })).toMatchObject({
      kind: 'BREACHED',
      rule: 'DAILY_LOSS',
    });
  });
});

describe('duration', () => {
  it('expires a phase past its last day', () => {
    expect(at({ dayNumber: 30 }).kind).toBe('ONGOING');
    expect(at({ dayNumber: 31 })).toMatchObject({ kind: 'BREACHED', rule: 'MAX_DAYS' });
    expect(at({ dayNumber: 400 }, { maxDays: null }).kind).toBe('ONGOING');
  });

  it('never expires a funded account, which has no target', () => {
    expect(at({ dayNumber: 400 }, { profitTargetPct: null }).kind).toBe('ONGOING');
  });

  it('counts calendar days with the first day as 1', () => {
    expect(dayNumber('2026-11-18', '2026-11-18')).toBe(1);
    expect(dayNumber('2026-11-18', '2026-12-18')).toBe(31);
  });
});

describe('plan terms', () => {
  it('accepts sane terms and names the first that is not', () => {
    expect(termsProblem(terms)).toBeNull();
    expect(termsProblem({ ...terms, dailyLossPct: '0' })).toMatch(/dailyLossPct/);
    expect(termsProblem({ ...terms, dailyLossPct: '12' })).toMatch(/cannot exceed/);
    expect(termsProblem({ ...terms, minTradingDays: 40 })).toMatch(/maxDays cannot/);
    expect(termsProblem({ ...terms, maxDays: 0 })).toMatch(/maxDays/);
    expect(termsProblem({ ...terms, profitTargetPct: '1e3' })).toMatch(/profitTargetPct/);
  });
});
