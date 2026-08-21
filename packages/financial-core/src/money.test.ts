import { describe, expect, it } from 'vitest';
import { Money } from './money';

describe('Money', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.of('99882.03', 'USD');
    const b = Money.of('-317.00', 'USD');
    expect(a.plus(b).toString()).toBe('99565.03');
    expect(a.minus(Money.of('9167.30', 'USD')).toString()).toBe('90714.73');
  });

  it('refuses to mix currencies rather than guessing a rate', () => {
    const usd = Money.of('100', 'USD');
    const eur = Money.of('100', 'EUR');
    expect(() => usd.plus(eur)).toThrow(/Convert explicitly/);
    expect(() => usd.gt(eur)).toThrow(/Convert explicitly/);
  });

  it('converts only with an explicit positive rate', () => {
    expect(Money.of('100', 'EUR').convertTo('USD', '1.0875').toString()).toBe('108.75');
    expect(() => Money.of('100', 'EUR').convertTo('USD', '0')).toThrow(RangeError);
    expect(() => Money.of('100', 'EUR').convertTo('USD', '-1')).toThrow(RangeError);
  });

  it('rounds to the currency’s minor units, not a hardcoded 2', () => {
    expect(Money.of('1234.567', 'USD').toString()).toBe('1234.57');
    expect(Money.of('1234.567', 'JPY').toString()).toBe('1235');
  });

  it('keeps full precision internally until rounding is asked for', () => {
    const third = Money.of('100', 'USD').dividedBy('3');
    expect(third.toExactString().startsWith('33.3333333333')).toBe(true);
    expect(third.toString()).toBe('33.33');
  });

  it('rejects unknown currencies loudly', () => {
    expect(() => Money.of('1', 'XYZ')).toThrow(/Unknown currency/);
  });

  it('rejects division by zero', () => {
    expect(() => Money.of('1', 'USD').dividedBy(0)).toThrow(RangeError);
  });

  it('sums a list without floating drift', () => {
    const items = Array.from({ length: 100 }, () => Money.of('0.01', 'USD'));
    expect(Money.sum(items, 'USD').toString()).toBe('1.00');
  });

  it('serialises as a string amount, never a JSON number', () => {
    expect(Money.of('4583.65', 'USD').toJSON()).toEqual({ amount: '4583.65', currency: 'USD' });
  });
});
