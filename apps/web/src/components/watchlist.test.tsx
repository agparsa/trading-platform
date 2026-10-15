// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The watchlist row's own ticket, rendered.
 *
 * The helpers it uses — `volumeProblem`, `inlineStartVolume` — have unit
 * tests; what those cannot show is that the row asks them, refuses to stage a
 * volume they refuse, and hands the volume it shows to the ticket rather than
 * the one the ticket already held. The data hooks are replaced; the row is
 * the real component.
 */
vi.mock('@/lib/queries', () => ({
  useQuoteSnapshot: () => ({ data: [] }),
  useMarketStats: () => ({ data: [], isError: false }),
}));

const { Watchlist } = await import('./watchlist');
const { useRealtime } = await import('@/lib/realtime-store');

const base = {
  description: '',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  marginRate: '0.01',
  commissionPerLot: '0',
  swapLongPerLot: '0',
  swapShortPerLot: '0',
  enabled: true,
  sessionOpen: true,
};

const GOLD = {
  ...base,
  code: 'XAUUSD',
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
} as never;

/** Dealt in whole lots: the trader's 0.10 default is no volume at all here. */
const INDEX = {
  ...base,
  code: 'USIDX',
  volumeStep: '1',
  volumePrecision: 0,
  minVolume: '1',
  maxVolume: '20',
} as never;

const CLOSED = { ...(GOLD as object), code: 'XAGUSD', sessionOpen: false } as never;

const quotes = () =>
  useRealtime.setState({
    quotes: {
      XAUUSD: { symbol: 'XAUUSD', bid: '4583.58', ask: '4583.72', spread: '0.14', at: 1 },
      USIDX: { symbol: 'USIDX', bid: '6500.10', ask: '6500.60', spread: '0.50', at: 1 },
      XAGUSD: { symbol: 'XAGUSD', bid: '51.20', ask: '51.24', spread: '0.04', at: 1 },
    },
  } as never);

afterEach(cleanup);

function renderList(onTrade = vi.fn(), onSelect = vi.fn()) {
  quotes();
  render(
    <Watchlist
      symbols={[GOLD, INDEX, CLOSED]}
      selected={null}
      onSelect={onSelect}
      onTrade={onTrade}
      defaultVolume="0.10"
    />,
  );
  return { onTrade, onSelect };
}

const open = (code: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Open the ${code} row ticket` }));

describe('a watchlist row ticket', () => {
  it("opens on the trader's default and stages that volume, side and instrument", () => {
    const { onTrade, onSelect } = renderList();
    open('XAUUSD');
    expect(screen.getByLabelText('XAUUSD volume in lots')).toHaveProperty('value', '0.10');

    fireEvent.click(screen.getByRole('button', { name: 'Increase the XAUUSD volume' }));
    fireEvent.click(
      screen.getByRole('button', { name: /^Sell 0\.11 lots of XAUUSD at 4583\.58$/ }),
    );
    expect(onTrade).toHaveBeenCalledWith('XAUUSD', 'SELL', '0.11');
    // Opening a ticket is not choosing the chart's instrument; staging does
    // that, in the terminal.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens on the instrument's minimum where the default is not a volume it takes", () => {
    const { onTrade } = renderList();
    open('USIDX');
    expect(screen.getByLabelText('USIDX volume in lots')).toHaveProperty('value', '1');
    fireEvent.click(screen.getByRole('button', { name: /^Buy 1 lots of USIDX at 6500\.60$/ }));
    expect(onTrade).toHaveBeenCalledWith('USIDX', 'BUY', '1');
  });

  it('says what is wrong with a volume and stages nothing until it is right', () => {
    const { onTrade } = renderList();
    open('USIDX');
    const field = screen.getByLabelText('USIDX volume in lots');
    fireEvent.change(field, { target: { value: '1.5' } });

    expect(screen.getByText('Volume must be a multiple of 1.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const buy = screen.getByRole('button', { name: /^Buy 1\.5 lots of USIDX/ });
    expect(buy).toHaveProperty('disabled', true);
    fireEvent.click(buy);
    expect(onTrade).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Buy 2 lots of USIDX/ }));
    expect(onTrade).toHaveBeenCalledWith('USIDX', 'BUY', '2');
  });

  it('offers no price to deal at on a closed market', () => {
    const { onTrade } = renderList();
    open('XAGUSD');
    expect(screen.getByText(/This market is closed/)).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: /lots of XAGUSD/ })) {
      expect(button).toHaveProperty('disabled', true);
    }
    expect(onTrade).not.toHaveBeenCalled();
  });

  it('keeps one row open at a time, and closes it on a second press', () => {
    renderList();
    open('XAUUSD');
    open('USIDX');
    expect(screen.queryByLabelText('XAUUSD volume in lots')).toBeNull();
    expect(screen.getByLabelText('USIDX volume in lots')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Close the USIDX row ticket' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('row-ticket-USIDX');
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('USIDX volume in lots')).toBeNull();
  });
});
