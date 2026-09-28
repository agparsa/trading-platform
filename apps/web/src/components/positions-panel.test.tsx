// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PositionRow } from '@/lib/queries';

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
const closeAll = vi.fn();

vi.mock('@/lib/queries', () => ({
  useClosePosition: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseAllPositions: () => ({ mutateAsync: closeAll, isPending: false }),
  useModifyPosition: () => ({ mutateAsync: modify, isPending: false }),
  useReversePosition: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({ api: {}, accessToken: 'test' }),
}));

const downloadCsv = vi.fn();
vi.mock('@/lib/csv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (...args: unknown[]) => downloadCsv(...args),
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
const POSITION: PositionRow = {
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
};

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

function renderPanel(positions: unknown[] = [POSITION]) {
  render(
    <PositionsPanel
      positions={positions as never}
      symbols={[XAUUSD]}
      accountId="acc-1"
      currency="USD"
      snapshot={SNAPSHOT}
      preferences={DEFAULT_PREFERENCES as never}
      shortcut={null}
      onShortcutHandled={() => undefined}
    />,
  );
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: /^Manage$/ }));
}

afterEach(() => {
  cleanup();
  modify.mockReset();
  closeAll.mockReset();
  downloadCsv.mockReset();
});

/**
 * The filter and the file read the same rows. What is pinned: typing narrows
 * the table; the count says so; the export writes the narrowed rows and no
 * other, with the server's own decimals; Escape clears it; and a ticked row
 * that the filter hides is still ticked when it comes back.
 */
describe('filtering and exporting the open positions, rendered', () => {
  const euro = { ...POSITION, id: 'pos-eur', symbol: 'EURUSD', entryPrice: '1.10000' };

  it('narrows the table, counts what is shown, and exports exactly that', () => {
    renderPanel([POSITION, euro]);
    expect(screen.getAllByRole('checkbox', { name: /^Select .* (XAUUSD|EURUSD)$/ })).toHaveLength(
      2,
    );

    fireEvent.change(screen.getByLabelText('Filter positions'), { target: { value: 'eur' } });
    expect(screen.getAllByRole('checkbox', { name: /^Select .* (XAUUSD|EURUSD)$/ })).toHaveLength(
      1,
    );
    expect(screen.getByText(/1 of 2 shown/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [csv, filename] = downloadCsv.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^open-positions-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"positionId"');
    expect(lines[1]).toContain('"pos-eur"');
    expect(lines[1]).toContain('"1.10000"');
    expect(csv).not.toContain('pos-1');

    fireEvent.change(screen.getByLabelText('Filter positions'), { target: { value: 'nothing' } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Filter positions'), { key: 'Escape' });
    expect(screen.getAllByRole('checkbox', { name: /^Select .* (XAUUSD|EURUSD)$/ })).toHaveLength(
      2,
    );
  });

  it('keeps a hidden row ticked, and "select every" ticks what is shown', () => {
    renderPanel([POSITION, euro]);
    const gold = screen.getByRole('checkbox', { name: /^Select .* XAUUSD$/ });
    fireEvent.click(gold);
    fireEvent.change(screen.getByLabelText('Filter positions'), { target: { value: 'eur' } });
    // Gold is hidden; still one selected.
    expect(screen.getByTestId('selection-bar').textContent).toMatch(/1 of 2 selected/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every position' }));
    expect(screen.getByTestId('selection-bar').textContent).toMatch(/2 of 2 selected/);
    fireEvent.change(screen.getByLabelText('Filter positions'), { target: { value: '' } });
    const boxes = screen.getAllByRole('checkbox', {
      name: /^Select .* (XAUUSD|EURUSD)$/,
    }) as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true]);
  });
});

/**
 * "Close (n)": ticked rows go to the server as one command naming them, not
 * as a loop of single closes. What is pinned is the wire: the ids of the
 * ticked rows and no other, after the confirmation, and a selection that
 * forgets what closed and keeps what was refused.
 */
describe('closing a selection, rendered', () => {
  const second = { ...POSITION, id: 'pos-2', symbol: 'XAUUSD' };
  const third = { ...POSITION, id: 'pos-3', symbol: 'XAUUSD' };

  it('sends exactly the ticked positions as one command, after asking', async () => {
    closeAll.mockResolvedValue({
      asked: 2,
      closed: [{ positionId: 'pos-1' }, { positionId: 'pos-3' }],
      refused: [],
    });
    renderPanel([POSITION, second, third]);
    expect(screen.queryByTestId('selection-bar')).toBeNull();

    const boxes = screen.getAllByRole('checkbox', { name: /^Select .* XAUUSD$/ });
    expect(boxes).toHaveLength(3);
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!);
    expect(screen.getByTestId('selection-bar').textContent).toMatch(/2 of 3 selected/);

    fireEvent.click(screen.getByRole('button', { name: /^Close \(2\)$/ }));
    // Asked first — a close is not undone at the same price.
    expect(closeAll).not.toHaveBeenCalled();
    expect(screen.getByText(/Close the 2 selected positions at market\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));

    await waitFor(() => {
      expect(closeAll).toHaveBeenCalledTimes(1);
    });
    expect(closeAll.mock.calls[0]?.[0]).toEqual({
      accountId: 'acc-1',
      positionIds: ['pos-1', 'pos-3'],
    });
    await waitFor(() => {
      expect(screen.queryByTestId('selection-bar')).toBeNull();
    });
  });

  it('keeps what the server refused ticked, and says so', async () => {
    closeAll.mockResolvedValue({
      asked: 2,
      closed: [{ positionId: 'pos-1' }],
      refused: [{ positionId: 'pos-2', code: 'STALE_QUOTE', message: 'No fresh quote.' }],
    });
    renderPanel([POSITION, second]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every position' }));
    fireEvent.click(screen.getByRole('button', { name: /^Close \(2\)$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    await waitFor(() => {
      expect(closeAll).toHaveBeenCalledTimes(1);
    });
    expect(closeAll.mock.calls[0]?.[0]).toEqual({
      accountId: 'acc-1',
      positionIds: ['pos-1', 'pos-2'],
    });
    await waitFor(() => {
      expect(screen.getByText(/1 closed\. One is still open: No fresh quote\./)).toBeTruthy();
    });
    const boxes = screen.getAllByRole('checkbox', {
      name: /^Select .* XAUUSD$/,
    }) as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
  });
});

describe('the position editor, rendered', () => {
  it('turns money into the stop price it sends, and shows that price first', async () => {
    modify.mockResolvedValue({});
    renderPanel();
    openEditor();

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
    openEditor();
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
    openEditor();
    fireEvent.change(screen.getByLabelText('Stop loss'), { target: { value: '3988' } });
    fireEvent.change(screen.getByLabelText('Stop loss unit'), { target: { value: 'percent' } });
    expect((screen.getByLabelText('Stop loss') as HTMLInputElement).value).toBe('');
  });

  it('sends a price as typed, and an empty field as a cleared level', async () => {
    modify.mockResolvedValue({});
    renderPanel();
    openEditor();
    fireEvent.change(screen.getByLabelText('Take profit'), { target: { value: '4012' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply levels/ }));
    await waitFor(() => {
      expect(modify).toHaveBeenCalledTimes(1);
    });
    expect(modify.mock.calls[0]?.[0]).toMatchObject({ stopLoss: null, takeProfit: '4012' });
  });
});
