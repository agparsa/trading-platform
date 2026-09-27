import { describe, expect, it } from 'vitest';
import { LEVEL_MODES, describeLevel, priceFromEntry, type LevelContext } from './level-entry';
import type { SymbolRow } from './queries';

const XAUUSD: SymbolRow = {
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

/** One lot of gold, long from 4000, on a $10,000 account. */
const stop: LevelContext = {
  spec: XAUUSD,
  side: 'BUY',
  kind: 'STOP_LOSS',
  volume: '1',
  entryPrice: '4000',
  accountCurrency: 'USD',
  equity: '10000',
};
const target: LevelContext = { ...stop, kind: 'TAKE_PROFIT' };

/**
 * Five ways of saying one stop. Each mode below resolves to the same order —
 * a stop at 3988 on a long from 4000 — because each is that stop in a
 * different unit: $12 of price, 1,200 points, $1,200 of money, 12% of a
 * $10,000 account. A mode that resolved to a different price would be a
 * calculator disagreeing with itself, which is what the shared one was
 * written to end.
 */
describe('a level entered in the trader’s own unit', () => {
  it('offers the five units, price first', () => {
    expect(LEVEL_MODES.map((m) => m.mode)).toEqual([
      'price',
      'distance',
      'points',
      'money',
      'percent',
    ]);
  });

  it('resolves the same stop from every unit', () => {
    expect(priceFromEntry('price', '3988', stop)).toBe('3988');
    expect(priceFromEntry('distance', '12', stop)).toBe('3988.00');
    expect(priceFromEntry('points', '1200', stop)).toBe('3988.00');
    expect(priceFromEntry('money', '1200', stop)).toBe('3988.00');
    expect(priceFromEntry('percent', '12', stop)).toBe('3988.00');
  });

  it('puts a target on the other side, from the same words', () => {
    expect(priceFromEntry('distance', '12', target)).toBe('4012.00');
    expect(priceFromEntry('money', '1200', target)).toBe('4012.00');
    // A short's stop is above, its target below.
    expect(priceFromEntry('distance', '12', { ...stop, side: 'SELL' })).toBe('4012.00');
    expect(priceFromEntry('points', '1200', { ...target, side: 'SELL' })).toBe('3988.00');
  });

  it('ignores a sign the trader typed: the kind decides the side', () => {
    expect(priceFromEntry('distance', '-12', stop)).toBe('3988.00');
    expect(priceFromEntry('money', '-1200', stop)).toBe('3988.00');
  });

  it('scales money by the volume, and never risks more than was named', () => {
    // 0.3 lots: $250 is 8.333… of price; the stop rounds to 3991.67, which
    // risks $249.90, not $250.20.
    const price = priceFromEntry('money', '250', { ...stop, volume: '0.3' });
    expect(price).toBe('3991.67');
    expect(describeLevel(price, { ...stop, volume: '0.3' })?.outcome).toBe('-249.90');
  });

  it('answers nothing while the entry is empty, half-typed, or not that unit', () => {
    expect(priceFromEntry('price', '', stop)).toBeNull();
    expect(priceFromEntry('price', '0', stop)).toBeNull();
    expect(priceFromEntry('distance', '12.', stop)).toBeNull();
    expect(priceFromEntry('points', '12.5', stop)).toBeNull();
    expect(priceFromEntry('money', 'twelve', stop)).toBeNull();
  });

  it('answers nothing in the money units when the currencies differ', () => {
    const eur = { ...stop, accountCurrency: 'EUR' };
    expect(priceFromEntry('money', '1200', eur)).toBeNull();
    expect(priceFromEntry('percent', '12', eur)).toBeNull();
    // Distance and points need no rate, so they still answer.
    expect(priceFromEntry('distance', '12', eur)).toBe('3988.00');
  });

  it('answers nothing in percent without equity to take a percent of', () => {
    expect(priceFromEntry('percent', '12', { ...stop, equity: null })).toBeNull();
    expect(priceFromEntry('percent', '12', { ...stop, equity: '0' })).toBeNull();
  });

  it('describes a resolved price in every unit at once', () => {
    expect(describeLevel('3988', stop)).toEqual({
      price: '3988',
      distance: { price: '12', points: 1200 },
      outcome: '-1200.00',
      percentOfEquity: '12',
    });
    expect(describeLevel(null, stop)).toBeNull();
  });
});
