import { describe, expect, it } from 'vitest';
import { dayIn, performanceOf, type ClosedTradeFigure } from './performance';

const at = (iso: string) => new Date(iso);
const trade = (side: 'BUY' | 'SELL', netPnl: string, exit: string): ClosedTradeFigure => ({
  side,
  netPnl,
  exitTime: at(exit),
});

describe('performance from closed trades', () => {
  const trades = [
    trade('BUY', '120.50', '2026-10-05T10:00:00Z'),
    trade('BUY', '-40.25', '2026-10-05T15:00:00Z'),
    trade('SELL', '-60.00', '2026-10-06T09:00:00Z'),
    trade('SELL', '0.00', '2026-11-02T08:00:00Z'),
    trade('BUY', '30.10', '2026-11-02T09:00:00Z'),
  ];
  const result = performanceOf({
    trades,
    currency: 'USD',
    timeZone: 'UTC',
    startingBalance: '10000.00',
  });

  it('counts profitable and losing trades by side, and a flat trade in neither', () => {
    expect(result.trades).toEqual({
      total: 5,
      buys: { total: 3, profitable: 2, losing: 1 },
      sells: { total: 2, profitable: 0, losing: 1 },
    });
  });

  it('adds the net results exactly, and averages wins and losses separately', () => {
    expect(result.netPnl).toBe('50.35');
    expect(result.grossProfit).toBe('150.60');
    expect(result.grossLoss).toBe('-100.25');
    expect(result.averageWin).toBe('75.30');
    expect(result.averageLoss).toBe('-50.13'); // -50.125, half up away from zero
    expect(result.profitFactor).toBe('1.50'); // 150.60 / 100.25 = 1.5022…
  });

  it('states the return against the starting balance, to two places', () => {
    expect(result.returnPercent).toBe('0.50'); // 50.35 / 10000 = 0.5035 %
  });

  it('groups by the day and month a trade closed, in the server timezone', () => {
    expect(result.days).toEqual({ total: 3, profitable: 2, losing: 1 });
    expect(result.months).toEqual([
      { month: '2026-10', netPnl: '20.25', trades: 3 },
      { month: '2026-11', netPnl: '30.10', trades: 2 },
    ]);
    // 22:30 UTC on 31 October is 1 November in Tehran.
    expect(dayIn(at('2026-10-31T22:30:00Z'), 'Asia/Tehran')).toBe('2026-11-01');
    expect(dayIn(at('2026-10-31T22:30:00Z'), 'UTC')).toBe('2026-10-31');
  });

  it('gives no profit factor without a loss, and no return without a starting balance', () => {
    const allWins = performanceOf({
      trades: [trade('BUY', '10.00', '2026-10-05T10:00:00Z')],
      currency: 'USD',
      timeZone: 'UTC',
      startingBalance: '0',
    });
    expect(allWins.profitFactor).toBeNull();
    expect(allWins.returnPercent).toBeNull();
    expect(allWins.averageLoss).toBeNull();
  });

  it('is all zeros and nulls for an account that has not traded', () => {
    const none = performanceOf({
      trades: [],
      currency: 'USD',
      timeZone: 'UTC',
      startingBalance: '500',
    });
    expect(none).toMatchObject({
      netPnl: '0.00',
      averageWin: null,
      averageLoss: null,
      profitFactor: null,
      returnPercent: '0.00',
      days: { total: 0, profitable: 0, losing: 0 },
      months: [],
    });
  });
});
