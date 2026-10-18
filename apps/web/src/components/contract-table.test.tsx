// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The contract specifications table, rendered. `useSymbolDetail` is replaced;
 * the table and its arithmetic are the real ones.
 */
const detail = vi.fn();
vi.mock('@/lib/queries', () => ({
  useSymbolDetail: (code: string) => detail(code),
}));

const { ContractTable } = await import('./contract-table');

const GOLD = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  category: 'Metals',
  quoteCurrency: 'USD',
  contractSize: '100.0000',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '7.0000',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
} as never;

afterEach(() => {
  cleanup();
  detail.mockReset();
});

const rowOf = (code: string) =>
  within(screen.getByTestId('contract-table'))
    .getAllByRole('row')
    .find((tr) => tr.textContent?.startsWith(code));

describe('the contract specifications', () => {
  it("states the firm's terms as the server sent them, without trailing zeros", () => {
    render(<ContractTable symbols={[GOLD]} leverage={100} />);
    const text = rowOf('XAUUSD')?.textContent ?? '';
    expect(text).toMatch(/Gold vs US Dollar · Metals/);
    expect(text).toMatch(/100quoted in USD/);
    expect(text).toMatch(/0\.011 USD a lot/);
    expect(text).toMatch(/0\.01 – 50step 0\.01/);
    expect(text).toMatch(/7 USD/);
    expect(text).toMatch(/-2\.5 \/ 1\.2/);
    // 1:100 is 1%, the instrument's own rate: nothing binds.
    expect(text).toMatch(/1%/);
    expect(text).not.toMatch(/your leverage sets it/);
  });

  it('shows the rate this account is charged when its leverage, not the instrument, sets it', () => {
    render(<ContractTable symbols={[GOLD]} leverage={30} />);
    const text = rowOf('XAUUSD')?.textContent ?? '';
    expect(text).toMatch(/3\.3333/);
    expect(text).toMatch(/instrument 1%; your leverage sets it/);
  });

  it('asks for the hours only when they are opened, and reads the week as one session', () => {
    detail.mockReturnValue({
      isError: false,
      data: {
        session: {
          symbol: 'XAUUSD',
          timezone: 'UTC',
          windows: [
            { day: 0, openMinute: 1320, closeMinute: 1440 },
            { day: 1, openMinute: 0, closeMinute: 1440 },
            { day: 2, openMinute: 0, closeMinute: 1440 },
            { day: 3, openMinute: 0, closeMinute: 1440 },
            { day: 4, openMinute: 0, closeMinute: 1440 },
            { day: 5, openMinute: 0, closeMinute: 1260 },
          ],
        },
      },
    });
    render(<ContractTable symbols={[GOLD]} leverage={100} />);
    expect(detail).not.toHaveBeenCalled();

    const button = screen.getByRole('button', { name: 'Hours for XAUUSD' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(detail).toHaveBeenCalledWith('XAUUSD');
    expect(screen.getByText('Sun 22:00 – Fri 21:00')).toBeTruthy();
    expect(screen.getByText(/Trading hours \(UTC\)/)).toBeTruthy();
  });

  it('says so when there are no instruments', () => {
    render(<ContractTable symbols={[]} leverage={100} />);
    expect(screen.getByText('No instruments are enabled.')).toBeTruthy();
  });
});
