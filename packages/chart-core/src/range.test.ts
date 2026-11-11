import { describe, expect, it } from 'vitest';
import { rangeOf } from './range';

const bar = (high: string, low: string) => ({
  time: 0,
  open: low,
  high,
  low,
  close: high,
  volume: '0',
});

describe('rangeOf', () => {
  it('is the highest high and the lowest low, in the bars’ own strings', () => {
    expect(rangeOf([bar('1.12513', '1.11800'), bar('1.12000', '1.11450')])).toEqual({
      high: '1.12513',
      low: '1.11450',
    });
  });

  it('compares as numbers, not as text', () => {
    expect(rangeOf([bar('99.5', '90'), bar('100.25', '9.75')])).toEqual({
      high: '100.25',
      low: '9.75',
    });
  });

  it('is null with nothing to measure, and skips an unreadable price', () => {
    expect(rangeOf([])).toBeNull();
    expect(rangeOf([bar('x', 'y'), bar('2', '1')])).toEqual({ high: '2', low: '1' });
  });
});
