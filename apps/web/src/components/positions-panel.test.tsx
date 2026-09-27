// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The position editor, rendered.
 *
 * `lib/level-entry.test.ts` proves that "$200 of risk" resolves to the right
 * stop price. This is the other half: that the editor offers the unit, shows
 * the price it resolved to before anything is sent, sends *that* price to the
 * API — not the digits the trader typed — and refuses to send while a level
 * has not resolved. A component that computed the right price and sent the
 * text would pass every unit test and set a stop of "200" on gold.
 */
const modify = vi.fn();

vi.mock('@/lib/queries', () => ({
  useClosePosition: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseAllPositions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useModifyPosition: () => ({ mutateAsync: modify, isPending: false }),
  useReversePosition: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({ api: {}, accessToken: 'test' }),
}));

const { PositionsPanel } = await import('./positions-panel');
const { DEFAULT_PREFERENCES } = await import('@/lib/trading-preferences');

const XAUUSD = {
  code: 'XAUUSD',
  description: 'Gold',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '0',
  swapLongPerLot: '0',
  swapShortPerLot: '0',
  enabled: true,
  sessionOpen: true,
} as never;

/** 0.3 lots of gold, long from 4000, no levels yet. */
const POSITION = {
  id: 'pos-1',
  symbol: 'XAUUSD',
  side: 'BUY',
  status: 'OPEN',
  volume: '0.30',
  initialVolume: '0.30',
  entryPrice: '4000.00',
  currentPrice: '4001.00',
  stopLoss: null,
  takeProfit: null,
  trailingStopDistance: null,
  highWaterPrice: null,
  margin: '120.00',
  commission: '0.00',
  swap: '0.00',
  realizedPnl: '0.00',
  closeReason: null,
  openedAt: '2026-09-27T10:00:00.000Z',
  closedAt: null,
} as never;

const SNAPSHOT = {
  accountId: 'acc-1',
  currency: 'USD',
  balance: '10000.00',
  equity: '10000.00',
  floatingPnl: '30.00',
  usedMargin: '120.00',
  freeMargin: '9880.00',
  marginLevel: null,
  marginUtilisation: null,
  grossExposure: '120000.00',
} as never;

function renderPanel() {
  render(
    <PositionsPanel
      positions={[POSITION]}
      symbols={[XAUUSD]}
      accountId="acc-1"
      currency="USD"
      snapshot={SNAPSHOT}
      preferences={DEFAULT_PREFERENCES as never}
      shortcut={null}
      onShortcutHandled={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Manage$/ }));
}

afterEach(() => {
  cleanup();
  modify.mockReset();
});

describe('the position editor, rendered', () => {
  it('turns money into the stop price it sends, and shows that price first', async () => {
    modify.mockResolvedValue({});
    renderPanel();

    fireEvent.change(screen.getByLabelText('Stop loss unit'), { target: { value: 'money' } });
    fireEvent.change(screen.getByLabelText('Stop loss'), { target: { value: '250' } });

    // 250 / (100 × 0.3) = 8.333… below 4000, rounded towards the entry.
    const readout = screen.getByTestId('stop-loss-readout').textContent ?? '';
    expect(readout).toMatch(/→ 3,?991\.67/);
    expect(readout).toMatch(/-\$249\.90/);
    expect(readout).toMatch(/2\.5% of equity/);

    fireEvent.click(screen.getByRole('button', { name: /Apply levels/ }));
    await waitFor(() => {
      expect(modify).toHaveBeenCalledTimes(1);
    });
    expect(modify.mock.calls[0]?.[0]).toMatchObject({
      positionId: 'pos-1',
      stopLoss: '3991.67',
      takeProfit: null,
      trailingStopDistance: null,
    });
  });

  it('will not send while a level is typed but has not resolved', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Take profit unit'), { target: { value: 'points' } });
    fireEvent.change(screen.getByLabelText('Take profit'), { target: { value: '12.5' } });

    const apply = screen.getByRole('button', { name: /Apply levels/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByTestId('take-profit-readout').textContent).toMatch(/Not a number yet/);

    fireEvent.change(screen.getByLabelText('Take profit'), { target: { value: '1200' } });
    expect(apply.disabled).toBe(false);
    expect(screen.getByTestId('take-profit-readout').textContent).toMatch(/→ 4,?012\.00/);
  });

  it('clears the text when the unit changes, rather than re-reading the digits', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Stop loss'), { target: { value: '3988' } });
    fireEvent.change(screen.getByLabelText('Stop loss unit'), { target: { value: 'percent' } });
    expect((screen.getByLabelText('Stop loss') as HTMLInputElement).value).toBe('');
  });

  it('sends a price as typed, and an empty field as a cleared level', async () => {
    modify.mockResolvedValue({});
    renderPanel();
    fireEvent.change(screen.getByLabelText('Take profit'), { target: { value: '4012' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply levels/ }));
    await waitFor(() => {
      expect(modify).toHaveBeenCalledTimes(1);
    });
    expect(modify.mock.calls[0]?.[0]).toMatchObject({ stopLoss: null, takeProfit: '4012' });
  });
});
