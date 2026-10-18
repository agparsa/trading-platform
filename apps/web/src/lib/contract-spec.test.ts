import { describe, expect, it } from 'vitest';
import { marginTerms, percentOf, plain, sessionLines, tickValuePerLot } from './contract-spec';
import type { SymbolRow } from './queries';

const GOLD: SymbolRow = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '5',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
};

const day = (d: number, open: number, close: number) => ({
  day: d,
  openMinute: open,
  closeMinute: close,
});

describe('contract figures', () => {
  it('writes decimals and rates without trailing zeros', () => {
    expect(plain('100.0000')).toBe('100');
    expect(plain('0.0100')).toBe('0.01');
    expect(percentOf('0.01')).toBe('1%');
    expect(percentOf('0.005')).toBe('0.5%');
  });

  it("values one tick of one lot with the engine's formula", () => {
    expect(tickValuePerLot(GOLD)).toBe('1');
    expect(tickValuePerLot({ ...GOLD, contractSize: '100000', tickSize: '0.00001' })).toBe('1');
  });

  it("charges the larger of the instrument's rate and the account's leverage", () => {
    expect(marginTerms(GOLD, 100)).toEqual({
      instrument: '1%',
      charged: '1%',
      leverageBinds: false,
    });
    // 1:50 is 2%, which is more than the instrument's 1%: the leverage binds.
    expect(marginTerms(GOLD, 50)).toEqual({
      instrument: '1%',
      charged: '2%',
      leverageBinds: true,
    });
    // 1:500 would be 0.2%; the instrument's 1% still stands.
    expect(marginTerms(GOLD, 500).charged).toBe('1%');
    expect(marginTerms(GOLD, undefined).charged).toBeNull();
  });
});

describe('sessionLines', () => {
  it('reads the metals week, stored a day at a time, as one session', () => {
    const windows = [
      day(0, 22 * 60, 1440),
      day(1, 0, 1440),
      day(2, 0, 1440),
      day(3, 0, 1440),
      day(4, 0, 1440),
      day(5, 0, 21 * 60),
    ];
    expect(sessionLines({ symbol: 'XAUUSD', timezone: 'UTC', windows })).toEqual([
      'Sun 22:00 – Fri 21:00',
    ]);
  });

  it('keeps a daily break as a break', () => {
    const windows = [day(1, 60, 1380), day(2, 60, 1380)];
    expect(sessionLines({ symbol: 'X', timezone: 'UTC', windows })).toEqual([
      'Mon 01:00 – Mon 23:00',
      'Tue 01:00 – Tue 23:00',
    ]);
  });

  it('says so when the market never closes, and when no hours are set', () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, 0, 1440));
    expect(sessionLines({ symbol: 'BTC', timezone: 'UTC', windows: always })).toEqual([
      'Around the clock, every day',
    ]);
    expect(sessionLines({ symbol: 'X', timezone: 'UTC', windows: [] })).toEqual([
      'No trading hours are configured',
    ]);
  });
});
