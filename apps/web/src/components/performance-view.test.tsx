// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The Analytics page's figures, rendered against a stand-in for the query.
 * What is tested is that the server's figures are what is shown, that the
 * period asked for is the one the trader chose, and that a figure the server
 * withheld is a dash with its reason — never a zero.
 */
const asked: string[] = [];
const state: { data: unknown } = { data: undefined };

vi.mock('@/lib/queries', () => ({
  usePerformance: (_accountId: string | null, period: string) => {
    asked.push(period);
    return { isError: false, data: state.data };
  },
}));

const { PerformanceView } = await import('./performance-view');

const figures = (over: Record<string, unknown> = {}) => ({
  period: '3M',
  from: '2026-08-02T00:00:00.000Z',
  to: '2026-11-02T00:00:00.000Z',
  timeZone: 'UTC',
  currency: 'USD',
  trades: {
    total: 5,
    buys: { total: 3, profitable: 2, losing: 1 },
    sells: { total: 2, profitable: 0, losing: 1 },
  },
  netPnl: '50.35',
  grossProfit: '150.60',
  grossLoss: '-100.25',
  averageWin: '75.30',
  averageLoss: '-50.13',
  profitFactor: '1.50',
  startingBalance: '10000.00',
  returnPercent: '0.50',
  days: { total: 3, profitable: 2, losing: 1 },
  months: [
    { month: '2026-10', netPnl: '20.25', trades: 3 },
    { month: '2026-11', netPnl: '30.10', trades: 2 },
  ],
  ...over,
});

afterEach(() => {
  cleanup();
  asked.length = 0;
});

describe('the Analytics figures', () => {
  it("shows the server's figures, by side and by month", () => {
    state.data = figures();
    render(<PerformanceView accountId="acc-1" />);
    const view = screen.getByTestId('performance');
    expect(within(view).getByText('+0.50%')).toBeTruthy();
    expect(within(view).getByText('1.50')).toBeTruthy();
    expect(within(view).getByText(/3 buys · 2 profitable · 1 losing/)).toBeTruthy();
    const months = within(screen.getByTestId('performance-months')).getAllByRole('row').slice(1);
    expect(months.map((row) => row.textContent)).toEqual([
      expect.stringContaining('2026-10'),
      expect.stringContaining('2026-11'),
    ]);
  });

  it('asks for the period the trader chooses', () => {
    state.data = figures();
    render(<PerformanceView accountId="acc-1" />);
    fireEvent.click(screen.getByRole('radio', { name: '1 year' }));
    expect(asked.at(-1)).toBe('1Y');
  });

  it('gives a withheld figure as a dash with the reason', () => {
    state.data = figures({ returnPercent: null, profitFactor: null, averageLoss: null });
    render(<PerformanceView accountId="acc-1" />);
    expect(screen.getByText(/no balance before this period began/)).toBeTruthy();
    expect(screen.getByText(/no trade in this period lost money/)).toBeTruthy();
    expect(screen.queryByText('0.00%')).toBeNull();
  });

  it('says so when nothing closed in the period', () => {
    state.data = figures({
      trades: {
        total: 0,
        buys: { total: 0, profitable: 0, losing: 0 },
        sells: { total: 0, profitable: 0, losing: 0 },
      },
    });
    render(<PerformanceView accountId="acc-1" />);
    expect(screen.getByText('No trades closed in this period.')).toBeTruthy();
  });

  it('speaks Persian when chosen, and leaves the figures as the server gave them', async () => {
    window.localStorage.setItem('tp:locale', 'fa');
    try {
      state.data = figures();
      render(<PerformanceView accountId="acc-1" />);
      expect(await screen.findAllByText('نتیجهٔ خالص')).toHaveLength(2);
      expect(screen.getByText('3 خرید · 2 سودده · 1 زیان‌ده')).toBeTruthy();
      expect(screen.getByText('+0.50%')).toBeTruthy();
      expect(screen.queryByText('Net result')).toBeNull();
    } finally {
      window.localStorage.removeItem('tp:locale');
    }
  });
});
