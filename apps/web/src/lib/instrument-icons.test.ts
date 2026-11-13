import { describe, expect, it } from 'vitest';
import { iconFor } from './instrument-marks';

describe('instrument icons', () => {
  it('draws a pair as two discs, base first', () => {
    const [base, quote] = iconFor('EURUSD');
    expect(base?.glyph).toBe('€');
    expect(quote?.glyph).toBe('$');
    expect(base?.fill).not.toBe(quote?.fill);
    expect(iconFor('USDJPY').map((disc) => disc.glyph)).toEqual(['$', '¥']);
    expect(iconFor('GBPUSD')[0]?.glyph).toBe('£');
  });

  it('draws a metal or a coin as one disc of its own', () => {
    expect(iconFor('XAUUSD')).toEqual([{ glyph: 'Au', fill: '#c99a2e' }]);
    expect(iconFor('XAGUSD')[0]?.glyph).toBe('Ag');
    expect(iconFor('BTCUSD')[0]?.glyph).toBe('₿');
    expect(iconFor('ETHUSD')[0]?.glyph).toBe('Ξ');
  });

  it('still draws something for a code it does not know', () => {
    expect(iconFor('US500')).toEqual([{ glyph: 'US', fill: '#5a6472' }]);
  });
});
