// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The Finance tab, rendered against a stand-in for `useLedger`.
 *
 * The data hook is replaced; what is tested is that the panel shows every
 * entry the pages hold, once, in the server's order, with the server's sign
 * and balance — and asks for older pages only when the trader does.
 */
const state: {
  current: Record<string, unknown>;
} = { current: {} };

vi.mock('@/lib/queries', () => ({
  useLedger: () => state.current,
}));

const { FinancePanel } = await import('./finance-panel');

const row = (id: string, type: string, amount: string, balanceAfter: string) => ({
  id,
  type,
  amount,
  balanceAfter,
  currency: 'USD',
  description: type === 'COMMISSION' ? 'XAUUSD exit commission' : null,
  createdAt: '2026-10-17T08:00:00.000Z',
});

afterEach(cleanup);

describe('the Finance tab', () => {
  it('lists every movement newest first, with its sign and the balance it left', () => {
    state.current = {
      isLoading: false,
      isError: false,
      hasNextPage: false,
      data: {
        pages: [
          {
            entries: [
              row('c', 'COMMISSION', '-7.00', '100011.94'),
              row('b', 'TRADE_PROFIT', '136.94', '100018.94'),
            ],
          },
          // A refetch can hand an entry back on the next page too.
          {
            entries: [
              row('b', 'TRADE_PROFIT', '136.94', '100018.94'),
              row('a', 'DEPOSIT', '99882.00', '99882.00'),
            ],
          },
        ],
      },
    };
    render(<FinancePanel accountId="acc-1" />);
    const table = screen.getByTestId('balance-history');
    const lines = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Commission.*XAUUSD exit commission.*-\$7\.00.*\$100,011\.94/);
    expect(lines[1]).toMatch(/Closed trade.*\+\$136\.94.*\$100,018\.94/);
    expect(lines[2]).toMatch(/Deposit.*\+\$99,882\.00/);
    expect(screen.queryByRole('button', { name: /Load older/ })).toBeNull();
    expect(screen.getByText('3 movement(s)')).toBeTruthy();
  });

  it('loads older movements only when asked', () => {
    const fetchNextPage = vi.fn();
    state.current = {
      isLoading: false,
      isError: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
      data: { pages: [{ entries: [row('a', 'DEPOSIT', '10.00', '10.00')] }] },
    };
    render(<FinancePanel accountId="acc-1" />);
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(screen.getByText('1 movement(s) loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older movements' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('says so when there is nothing, and when it could not load — never an empty table', () => {
    state.current = {
      isLoading: false,
      isError: false,
      hasNextPage: false,
      data: { pages: [{ entries: [] }] },
    };
    render(<FinancePanel accountId="acc-1" />);
    expect(screen.getByText('No balance movements on this account yet.')).toBeTruthy();
    cleanup();

    state.current = { isLoading: false, isError: true, data: undefined };
    render(<FinancePanel accountId="acc-1" />);
    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByTestId('balance-history')).toBeNull();
  });
});
