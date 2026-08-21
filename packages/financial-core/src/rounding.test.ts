import { describe, expect, it } from 'vitest';
import { isOnGrid, quantize, roundTo, RoundingMode } from './rounding';

describe('roundTo', () => {
  it('rounds half away from zero by default', () => {
    expect(roundTo('2.345', 2).toString()).toBe('2.35');
    expect(roundTo('-2.345', 2).toString()).toBe('-2.35');
  });

  it('supports banker’s rounding for bias-free aggregation', () => {
    expect(roundTo('2.5', 0, RoundingMode.HALF_EVEN).toString()).toBe('2');
    expect(roundTo('3.5', 0, RoundingMode.HALF_EVEN).toString()).toBe('4');
  });

  it('rejects a negative or fractional place count', () => {
    expect(() => roundTo('1', -1)).toThrow(RangeError);
    expect(() => roundTo('1', 1.5)).toThrow(RangeError);
  });
});

describe('quantize', () => {
  it('snaps onto a grid that is not a power of ten', () => {
    expect(quantize('4583.67', '0.05').toString()).toBe('4583.65');
    expect(quantize('4583.69', '0.05', RoundingMode.HALF_UP).toString()).toBe('4583.7');
  });

  it('rounds volume down so a trader never gets more risk than requested', () => {
    expect(quantize('0.079', '0.01').toString()).toBe('0.07');
    expect(quantize('0.019', '0.01').toString()).toBe('0.01');
  });

  it('rejects a non-positive step', () => {
    expect(() => quantize('1', '0')).toThrow(RangeError);
    expect(() => quantize('1', '-0.01')).toThrow(RangeError);
  });
});

describe('isOnGrid', () => {
  it('detects off-step values', () => {
    expect(isOnGrid('0.05', '0.01')).toBe(true);
    expect(isOnGrid('0.005', '0.01')).toBe(false);
  });
});
