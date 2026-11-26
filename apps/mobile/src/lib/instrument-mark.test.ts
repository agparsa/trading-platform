import { describe, expect, it } from 'vitest';
import { instrumentMark } from './instrument-mark';

describe('marking an instrument', () => {
  it('knows a pair, a metal and a coin by their codes', () => {
    expect(instrumentMark('EURUSD')).toMatchObject({ family: 'fx', glyph: '€' });
    expect(instrumentMark('USDJPY')).toMatchObject({ family: 'fx', glyph: '$' });
    expect(instrumentMark('XAUUSD')).toMatchObject({ family: 'metal', glyph: 'Au' });
    expect(instrumentMark('btcusd')).toMatchObject({ family: 'crypto', glyph: '₿' });
  });

  it('marks something it does not know plainly, never as a pair', () => {
    expect(instrumentMark('US500')).toMatchObject({ family: 'other', glyph: 'US' });
    expect(instrumentMark('EURXYZ').family).toBe('other');
  });
});
