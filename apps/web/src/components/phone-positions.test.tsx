// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PositionRow } from '@/lib/queries';

/**
 * The phone's position cards. What is pinned: Break even sends one modify
 * that moves the stop to the entry and keeps the target and the trail as
 * they were — a modify that dropped them would quietly delete a take-profit —
 * and Close asks first when confirmations are on.
 */
const modify = vi.fn().mockResolvedValue({});
const close = vi.fn().mockResolvedValue({});

vi.mock('@/lib/queries', () => ({
  useClosePosition: () => ({ mutateAsync: close, isPending: false }),
  useCloseAllPositions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useModifyPosition: () => ({ mutateAsync: modify, isPending: false }),
  useReversePosition: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./pending-panel', () => ({ PendingPanel: () => null }));
vi.mock('./history-panel', () => ({ HistoryPanel: () => null }));

const { PhonePositions } = await import('./phone-positions');

const POSITION: PositionRow = {
  id: 'pos-1',
  symbol: 'XAUUSD',
  side: 'BUY',
  status: 'OPEN',
  volume: '0.30',
  initialVolume: '0.30',
  entryPrice: '4000.00',
  currentPrice: '4010.00',
  stopLoss: '3990.00',
  takeProfit: '4100.00',
  trailingStopDistance: '15.00',
  highWaterPrice: null,
  margin: '120.00',
  commission: '0.00',
  swap: '0.00',
  realizedPnl: '0.00',
  closeReason: null,
  openedAt: '2026-11-11T10:00:00.000Z',
  closedAt: null,
};

function renderCards(confirm: boolean) {
  render(
    <PhonePositions
      positions={[POSITION]}
      pending={[]}
      symbols={[]}
      accountId="acc-1"
      currency="USD"
      state={null}
      preferences={{ confirm } as never}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /XAUUSD/ }));
}

afterEach(() => {
  cleanup();
  modify.mockClear();
  close.mockClear();
});

describe('the phone position cards', () => {
  it('moves the stop to the entry on Break even, keeping the target and the trail', async () => {
    renderCards(true);
    fireEvent.click(screen.getByRole('button', { name: 'Break even' }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    expect(modify.mock.calls[0]?.[0]).toEqual({
      positionId: 'pos-1',
      stopLoss: '4000.00',
      takeProfit: '4100.00',
      trailingStopDistance: '15.00',
    });
  });

  it('asks before closing when confirmations are on, and closes the whole position', async () => {
    renderCards(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText('Close 0.30 XAUUSD at market?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(close).toHaveBeenCalledWith({ positionId: 'pos-1', volume: null }));
  });

  it('closes at once when confirmations are off', async () => {
    renderCards(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
