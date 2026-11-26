import { describe, expect, it } from 'vitest';
import { changePercent, sparkPath } from './spark';

describe('a day in one glance', () => {
  it('says the move as a signed percent, in decimals', () => {
    expect(changePercent('2000.00', '2010.00')).toBe('+0.50%');
    expect(changePercent('1.08500', '1.08283')).toBe('-0.20%');
    expect(changePercent('100', '100')).toBe('0.00%');
  });

  it('says nothing without a start, or with a start of zero', () => {
    expect(changePercent(null, '1')).toBeNull();
    expect(changePercent('0', '1')).toBeNull();
  });

  it('draws a line across the box, highest at the top', () => {
    expect(sparkPath([1, 2, 3], 10, 10)).toBe('M2.0,8.0 L5.0,5.0 L8.0,2.0');
    expect(sparkPath([5], 10, 10)).toBe('');
  });
});
