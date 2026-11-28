import { describe, expect, it } from 'vitest';
import { priceParts } from './price-parts';

describe('priceParts', () => {
  it('splits a five-decimal pair into lead, the two pips and the fractional pip', () => {
    expect(priceParts('1.08753', 5)).toEqual({ lead: '1.08', big: '75', pipette: '3' });
  });

  it('splits a three-decimal yen pair the same way', () => {
    expect(priceParts('151.234', 3)).toEqual({ lead: '151.', big: '23', pipette: '4' });
  });

  it('has no fractional pip on an even precision', () => {
    expect(priceParts('2650.45', 2)).toEqual({ lead: '2650.', big: '45', pipette: '' });
  });

  it('carries a decimal point that falls between the two digits', () => {
    expect(priceParts('96543.2', 1)).toEqual({ lead: '9654', big: '3.2', pipette: '' });
  });

  it('leaves a placeholder alone', () => {
    expect(priceParts('—', 5)).toEqual({ lead: '—', big: '', pipette: '' });
  });

  it('never changes what the price says', () => {
    for (const [value, precision] of [
      ['1.08753', 5],
      ['0.5', 1],
      ['12', 0],
      ['96543.21', 2],
      ['151.234', 3],
    ] as const) {
      const parts = priceParts(value, precision);
      expect(parts.lead + parts.big + parts.pipette).toBe(value);
    }
  });
});
