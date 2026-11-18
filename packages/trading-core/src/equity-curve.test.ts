import { describe, expect, it } from 'vitest';
import { equityCurve } from './equity-curve';

const at = (iso: string, balance: string, equity: string) => ({
  takenAt: new Date(iso),
  balance,
  equity,
});

describe('equity curve', () => {
  it('keeps the last snapshot of each day and the day’s low', () => {
    const curve = equityCurve(
      [
        at('2026-11-02T10:00:00Z', '1000', '1000'),
        at('2026-11-02T12:00:00Z', '1000', '940'),
        at('2026-11-02T20:00:00Z', '1010', '1010'),
        at('2026-11-03T09:00:00Z', '1010', '1030'),
      ],
      'UTC',
    );
    expect(curve.points).toEqual([
      { day: '2026-11-02', balance: '1010', equity: '1010', lowEquity: '940' },
      { day: '2026-11-03', balance: '1010', equity: '1030', lowEquity: '1030' },
    ]);
  });

  it('measures the worst peak-to-trough fall, even one that recovered', () => {
    const curve = equityCurve(
      [
        at('2026-11-02T10:00:00Z', '1000', '1000'),
        at('2026-11-02T11:00:00Z', '1000', '1200'),
        at('2026-11-02T12:00:00Z', '1000', '900'),
        at('2026-11-02T13:00:00Z', '1000', '1300'),
        at('2026-11-02T14:00:00Z', '1000', '1250'),
      ],
      'UTC',
    );
    expect(curve.peakEquity).toBe('1300');
    expect(curve.maxDrawdown).toBe('300');
    expect(curve.maxDrawdownPercent).toBe('25.00');
  });

  it('orders samples by time whatever order they arrive in', () => {
    const curve = equityCurve(
      [at('2026-11-02T13:00:00Z', '1', '80'), at('2026-11-02T12:00:00Z', '1', '100')],
      'UTC',
    );
    expect(curve.maxDrawdown).toBe('20');
    expect(curve.points[0]?.equity).toBe('80');
  });

  it('puts a day where the trading server’s clock does', () => {
    const curve = equityCurve([at('2026-11-02T23:30:00Z', '1', '1')], 'Asia/Tehran');
    expect(curve.points[0]?.day).toBe('2026-11-03');
  });

  it('says no drawdown as zero, and nothing for no data', () => {
    expect(equityCurve([at('2026-11-02T10:00:00Z', '5', '5')], 'UTC')).toMatchObject({
      maxDrawdown: '0',
      maxDrawdownPercent: '0.00',
    });
    expect(equityCurve([], 'UTC')).toEqual({
      points: [],
      peakEquity: null,
      maxDrawdown: '0',
      maxDrawdownPercent: null,
    });
  });
});
