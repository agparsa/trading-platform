import { describe, expect, it } from 'vitest';
import { performanceSummary } from './performance-summary';

const base = {
  trades: {
    total: 5,
    buys: { profitable: 2, losing: 1 },
    sells: { profitable: 0, losing: 1 },
  },
  netPnl: '50.35',
  returnPercent: '0.50',
  averageWin: '75.30',
  averageLoss: '-50.13',
  profitFactor: '1.50',
};

describe('the History summary', () => {
  it("lays out the server's figures, signed, with wins and losses counted across sides", () => {
    const { lines, notes } = performanceSummary(base);
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ['Net result', '+50.35'],
      ['Return', '+0.50%'],
      ['Trades', '5 (2 won, 2 lost)'],
      ['Profit factor', '1.50'],
      ['Average win', '+75.30'],
      ['Average loss', '-50.13'],
    ]);
    expect(notes).toEqual([]);
  });

  it('gives a withheld figure as a dash, and says why', () => {
    const { lines, notes } = performanceSummary({
      ...base,
      returnPercent: null,
      profitFactor: null,
      averageLoss: null,
    });
    expect(lines.find((line) => line.label === 'Return')?.value).toBe('—');
    expect(lines.find((line) => line.label === 'Profit factor')?.value).toBe('—');
    expect(notes).toHaveLength(2);
    expect(lines.some((line) => line.value === '+0.00%')).toBe(false);
  });
});
