// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The Orders tab's trail, rendered. The data hooks are replaced; the table,
 * the toggle and the wording are the real ones.
 */
const events = vi.fn();
const ordersState: { current: Record<string, unknown> } = { current: {} };
const ORDER = {
  id: 'o-1',
  symbol: 'XAUUSD',
  side: 'BUY',
  type: 'LIMIT',
  status: 'REJECTED',
  volume: '1.00',
  filledVolume: '0',
  positionId: null,
  createdAt: '2026-10-19T08:00:00.000Z',
};
vi.mock('@/lib/queries', () => ({
  useTrades: () => ({ data: [] }),
  usePositions: () => ({ data: [] }),
  useOrders: () => ordersState.current,
  useOrderEvents: (id: string | null) => events(id),
}));

const { HistoryPanel } = await import('./history-panel');

afterEach(() => {
  cleanup();
  events.mockReset();
  ordersState.current = { isError: false, data: [ORDER] };
});
ordersState.current = { isError: false, data: [ORDER] };

describe("an order's trail in the Orders tab", () => {
  it('is read only when opened, and says what happened and why', () => {
    events.mockReturnValue({
      isError: false,
      data: [
        {
          type: 'CREATED',
          fromStatus: null,
          toStatus: 'NEW',
          payload: { volume: '1.00', price: '4500.00' },
          at: '2026-10-19T08:00:00.000Z',
        },
        {
          type: 'REJECTED',
          fromStatus: 'TRIGGERED',
          toStatus: 'REJECTED',
          payload: { reason: 'INSUFFICIENT_MARGIN' },
          at: '2026-10-19T09:15:00.000Z',
        },
      ],
    });
    render(<HistoryPanel tab="orders" accountId="acc-1" symbols={[]} currency="USD" />);
    // The hook runs for the closed row with no id, and so asks for nothing.
    expect(events.mock.calls.every(([id]) => id === undefined || id === null)).toBe(true);

    const toggle = screen.getByRole('button', { name: /Show the trail of the XAUUSD order/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(events).toHaveBeenCalledWith('o-1');

    const trail = within(screen.getByTestId('order-trail'));
    const steps = trail.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps[0]).toMatch(/Placed.*volume 1\.00 · price 4500\.00/);
    expect(steps[1]).toMatch(/Refused.*INSUFFICIENT_MARGIN/);

    fireEvent.click(screen.getByRole('button', { name: /Hide the trail/ }));
    expect(screen.queryByTestId('order-trail')).toBeNull();
  });

  it('says it is loading, or could not load — not that there are no orders', () => {
    ordersState.current = { isError: false, data: undefined };
    render(<HistoryPanel tab="orders" accountId="acc-1" symbols={[]} currency="USD" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('No orders yet.')).toBeNull();
    cleanup();

    ordersState.current = { isError: true, data: undefined };
    render(<HistoryPanel tab="orders" accountId="acc-1" symbols={[]} currency="USD" />);
    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('No orders yet.')).toBeNull();
  });
});
