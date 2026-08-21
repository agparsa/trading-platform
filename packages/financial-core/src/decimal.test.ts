import { describe, expect, it } from 'vitest';
import { Decimal, isDecimalString, toDecimal } from './decimal';

describe('Decimal configuration', () => {
  it('adds tenths exactly, unlike IEEE-754 doubles', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the bug this whole package exists to avoid
    expect(toDecimal('0.1').plus(toDecimal('0.2')).toString()).toBe('0.3');
  });

  it('never emits exponent notation, so wire strings stay parseable', () => {
    expect(new Decimal('0.00000001').toString()).toBe('0.00000001');
    expect(new Decimal('1000000000000000000000').toString()).toBe('1000000000000000000000');
  });

  it('keeps enough precision for chained instrument arithmetic', () => {
    const result = toDecimal('4583.65').mul('100000').mul('0.002').div('3');
    expect(result.toDecimalPlaces(10).toString()).toBe('305576.6666666667');
  });

  it('rejects non-integer JS numbers, which are already inexact on arrival', () => {
    expect(() => toDecimal(0.1)).toThrow(/non-integer number/);
    expect(toDecimal(42).toString()).toBe('42');
  });

  it('rejects non-finite numbers', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(/Non-finite/);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(/Non-finite/);
  });

  it('validates decimal strings', () => {
    expect(isDecimalString('4583.72')).toBe(true);
    expect(isDecimalString('-0.0001')).toBe(true);
    expect(isDecimalString('')).toBe(false);
    expect(isDecimalString('abc')).toBe(false);
  });
});
