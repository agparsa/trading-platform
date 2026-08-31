import { describe, expect, it } from 'vitest';
import {
  InstrumentKind,
  currencySymbol,
  hasCurrencySymbol,
  markClasses,
  markFor,
} from './instrument-marks';

describe('markFor', () => {
  it('gives the metals their element symbols', () => {
    expect(markFor('XAUUSD')).toMatchObject({ glyph: 'Au', kind: InstrumentKind.METAL });
    expect(markFor('XAGUSD')).toMatchObject({ glyph: 'Ag', kind: InstrumentKind.METAL });
  });

  it('gives the crypto their own', () => {
    expect(markFor('BTCUSD')).toMatchObject({ glyph: '₿', kind: InstrumentKind.CRYPTO });
    expect(markFor('ETHUSD')).toMatchObject({ glyph: 'Ξ', kind: InstrumentKind.CRYPTO });
  });

  it('reads an FX pair as two currencies', () => {
    expect(markFor('EURUSD')).toMatchObject({ glyph: '€$', kind: InstrumentKind.FX });
    expect(markFor('USDJPY')).toMatchObject({ glyph: '$¥', kind: InstrumentKind.FX });
    expect(markFor('GBPUSD').glyph).toBe('£$');
  });

  /**
   * The one that would be read wrong. AUDUSD is not a metal and not crypto; it
   * has to come out as an FX pair, and its glyph has to distinguish it from
   * USDCAD — both of which are a dollar against a dollar.
   */
  it('distinguishes the dollars', () => {
    expect(markFor('AUDUSD')).toMatchObject({ glyph: 'A$', kind: InstrumentKind.FX });
    expect(markFor('USDCAD')).toMatchObject({ glyph: '$C', kind: InstrumentKind.FX });
  });

  it('names what it shows, for a screen reader', () => {
    expect(markFor('XAUUSD').label).toBe('Gold');
    expect(markFor('EURUSD').label).toBe('EUR against USD');
  });

  it('is not case- or space-sensitive, because codes arrive from anywhere', () => {
    expect(markFor(' xauusd ')).toEqual(markFor('XAUUSD'));
  });

  /**
   * A blank badge in a list of full ones reads as a loading state, which is a
   * worse lie than an approximate mark.
   */
  it('always produces something, for a code it has never seen', () => {
    expect(markFor('WEIRD1').glyph).toBe('WE');
    expect(markFor('WEIRD1').kind).toBe(InstrumentKind.OTHER);
    expect(markFor('').glyph).toBe('—');
  });

  it('has a class for every kind', () => {
    for (const kind of Object.values(InstrumentKind)) {
      expect(markClasses(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('currencySymbol', () => {
  it('knows the majors', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('JPY')).toBe('¥');
  });

  /**
   * A wrong currency symbol on a balance is worse than no symbol, because it is
   * not obviously missing. An account in a currency this file has never heard
   * of shows its code.
   */
  it('falls back to the code rather than guessing a dollar', () => {
    expect(currencySymbol('ZZZ')).toBe('ZZZ');
    expect(hasCurrencySymbol('ZZZ')).toBe(false);
  });

  it('keeps the ambiguous dollars distinguishable', () => {
    expect(currencySymbol('AUD')).toBe('A$');
    expect(currencySymbol('CAD')).toBe('C$');
    expect(currencySymbol('USD')).toBe('$');
  });
});
