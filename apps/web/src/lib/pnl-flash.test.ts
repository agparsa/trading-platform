import { describe, expect, it } from 'vitest';
import { flashDirection } from './pnl-flash';

describe('flashDirection', () => {
  it('says up when the figure rose and down when it fell', () => {
    expect(flashDirection('-12.40', '-12.39')).toBe('profit');
    expect(flashDirection('5.00', '4.99')).toBe('loss');
  });

  it('sees a one-cent move on a figure too large for a double to keep', () => {
    expect(flashDirection('90071992547409.91', '90071992547409.92')).toBe('profit');
  });

  it('says nothing for a first value, an unchanged one, or an equal one spelt differently', () => {
    expect(flashDirection(null, '1.00')).toBeNull();
    expect(flashDirection(undefined, '1.00')).toBeNull();
    expect(flashDirection('1.00', null)).toBeNull();
    expect(flashDirection('1.00', '1.00')).toBeNull();
    expect(flashDirection('1.0', '1.00')).toBeNull();
  });

  it('says nothing rather than guessing at something that is not a number', () => {
    expect(flashDirection('1.00', 'n/a')).toBeNull();
  });
});
