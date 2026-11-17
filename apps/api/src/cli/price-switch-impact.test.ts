import { describe, expect, it } from 'vitest';
import type { SymbolSpec } from '@tp/financial-core';
import { impactOf, parsePrice, type OpenPosition } from './price-switch-impact';

const GOLD = {
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
  marginRate: '0.02',
  commissionPerLot: '0',
  swapLongPerLot: '0',
  swapShortPerLot: '0',
} as SymbolSpec;

const position = (overrides: Partial<OpenPosition>): OpenPosition => ({
  id: 'p1',
  accountNumber: 'TP-1',
  accountCurrency: 'USD',
  balance: '10000',
  symbol: 'XAUUSD',
  side: 'BUY',
  volume: '0.10',
  entryPrice: '4580.00',
  currentPrice: '4583.00',
  stopLoss: null,
  takeProfit: null,
  spec: GOLD,
  ...overrides,
});

describe('what a switch to the real gold price would do', () => {
  it('values a long at the new price and flags its stop', () => {
    const { positions, accounts } = impactOf([position({ stopLoss: '4500.00' })], {
      XAUUSD: '3884.01',
    });
    // 0.10 lot × 100 oz × (3884.01 − 4580.00) = −6959.90
    expect(positions[0]).toMatchObject({
      pnlAtNew: '-6959.90',
      pnlAtCurrent: '30.00',
      crosses: 'STOP_LOSS',
    });
    expect(accounts[0]).toMatchObject({ positions: 1, balanceWithNew: '3040.1' });
  });

  it('gains a short, flags its target, and sums an account', () => {
    const { positions, accounts } = impactOf(
      [
        position({ side: 'SELL', takeProfit: '4000.00' }),
        position({ id: 'p2', side: 'BUY', volume: '0.01' }),
      ],
      { XAUUSD: '3884.01' },
    );
    expect(positions[0]).toMatchObject({ pnlAtNew: '6959.90', crosses: 'TAKE_PROFIT' });
    expect(accounts).toEqual([
      expect.objectContaining({ positions: 2, pnlAtNew: '6263.91', balanceWithNew: '16263.91' }),
    ]);
  });

  it('converts a USDxxx pair, and reports a cross it cannot convert without a figure', () => {
    const jpy = { ...GOLD, code: 'USDJPY', quoteCurrency: 'JPY', contractSize: '100000' };
    const eurgbp = { ...GOLD, code: 'EURGBP', quoteCurrency: 'GBP', contractSize: '100000' };
    const { positions, accounts } = impactOf(
      [
        position({ symbol: 'USDJPY', spec: jpy, entryPrice: '155.000', currentPrice: null }),
        position({ id: 'p2', symbol: 'EURGBP', spec: eurgbp, entryPrice: '0.8500' }),
      ],
      { USDJPY: '159.688', EURGBP: '0.8400' },
    );
    expect(positions[0]?.pnlAtNew).not.toBeNull();
    expect(positions[0]?.pnlAtCurrent).toBeNull();
    expect(positions[1]?.pnlAtNew).toBeNull();
    expect(accounts[0]?.balanceWithNew).toBeNull();
  });

  it('ignores positions in instruments not being switched', () => {
    expect(impactOf([position({ symbol: 'BTCUSD' })], { XAUUSD: '3884.01' }).positions).toEqual([]);
  });

  it('reads a price argument, and refuses a malformed one', () => {
    expect(parsePrice('XAUUSD=3884.01')).toEqual(['XAUUSD', '3884.01']);
    expect(() => parsePrice('XAUUSD:3884')).toThrow(/SYMBOL=price/);
    expect(() => parsePrice('xauusd=1')).toThrow();
  });
});
