import { describe, expect, it } from 'vitest';
import { NO_CONVERSION, XAUUSD } from '../__fixtures__/instruments';
import { Money } from '../money';
import { normalizeVolume } from '../instrument';
import { effectiveMarginRate, maxVolumeForMargin, requiredMargin } from './margin';

describe('effectiveMarginRate', () => {
  it('uses account leverage when it is the tighter constraint', () => {
    // 500:1 -> 0.002, but XAUUSD demands 0.01, so the instrument wins.
    expect(effectiveMarginRate(XAUUSD, '500').toString()).toBe('0.01');
  });

  it('uses the instrument rate as a floor, never a ceiling', () => {
    // 20:1 -> 0.05, tighter than the instrument's 0.01.
    expect(effectiveMarginRate(XAUUSD, '20').toString()).toBe('0.05');
  });

  it('rejects non-positive leverage', () => {
    expect(() => effectiveMarginRate(XAUUSD, '0')).toThrow(RangeError);
  });
});

describe('requiredMargin', () => {
  // Reference terminal: XAUUSD 1.00 lot at 4583.65, 1.00% initial margin,
  // displayed margin $4,583.65 against $458,365.00 exposure.
  it('reproduces the reference terminal margin figure', () => {
    const margin = requiredMargin({
      spec: XAUUSD,
      volume: '1.00',
      price: '4583.65',
      accountLeverage: '100',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });
    expect(margin.toString()).toBe('4583.65');
  });

  it('scales linearly with volume', () => {
    const one = requiredMargin({
      spec: XAUUSD,
      volume: '1.00',
      price: '4583.65',
      accountLeverage: '100',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });
    const two = requiredMargin({
      spec: XAUUSD,
      volume: '2.00',
      price: '4583.65',
      accountLeverage: '100',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });
    expect(two.toString()).toBe(one.times(2).toString());
  });
});

describe('maxVolumeForMargin', () => {
  it('sizes a position to the available free margin', () => {
    const raw = maxVolumeForMargin(
      Money.of('10000', 'USD'),
      XAUUSD,
      '4583.65',
      '100',
      NO_CONVERSION,
    );
    expect(normalizeVolume(XAUUSD, raw).toString()).toBe('2.18');
  });

  it('returns zero when free margin is exhausted', () => {
    expect(
      maxVolumeForMargin(Money.of('0', 'USD'), XAUUSD, '4583.65', '100', NO_CONVERSION).toString(),
    ).toBe('0');
    expect(
      maxVolumeForMargin(
        Money.of('-500', 'USD'),
        XAUUSD,
        '4583.65',
        '100',
        NO_CONVERSION,
      ).toString(),
    ).toBe('0');
  });
});
