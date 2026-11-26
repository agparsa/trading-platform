import { describe, expect, it } from 'vitest';
import { changeColor, formatSigned, moved, signColor, theme } from './theme';

describe('showing a signed number', () => {
  it('marks a profit with a plus', () => {
    expect(formatSigned('125.40')).toBe('+125.40');
  });

  it('leaves a loss as it is', () => {
    expect(formatSigned('-125.40')).toBe('-125.40');
  });

  it('leaves zero alone', () => {
    expect(formatSigned('0.00')).toBe('0.00');
  });

  it('does not reformat the number', () => {
    /**
     * The string comes from the server as an exact decimal.
     *
     * Parsing it to a JavaScript number and formatting it back is where money
     * loses precision — 0.1 + 0.2 arithmetic in the one place a trader is
     * looking at their balance.
     */
    expect(formatSigned('1234567.8901234567')).toBe('+1234567.8901234567');
    expect(formatSigned('-0.0000000001')).toBe('-0.0000000001');
  });

  it('colours money by sign: blue for profit, red for loss', () => {
    expect(signColor('12')).toBe(theme.colors.profit);
    expect(signColor('-12')).toBe(theme.colors.negative);
    expect(signColor('0')).toBe(theme.colors.textMuted);
  });

  it('does not colour something that is not a number', () => {
    // A dash or an em-dash while a value is loading must not read as a loss.
    expect(signColor('—')).toBe(theme.colors.textMuted);
  });
});

describe('a price change is not money', () => {
  it('stays green up and red down', () => {
    expect(changeColor('0.5')).toBe(theme.colors.positive);
    expect(changeColor('-0.5')).toBe(theme.colors.negative);
    expect(changeColor('0')).toBe(theme.colors.textMuted);
  });
});

describe('which way a figure moved', () => {
  it('compares exactly, as decimals', () => {
    expect(moved('-12.40', '-12.39')).toBe('up');
    expect(moved('5.00', '4.99')).toBe('down');
    expect(moved('-0.01', '0.00')).toBe('up');
    expect(moved('9.99', '10.00')).toBe('up');
    expect(moved('90071992547409.91', '90071992547409.92')).toBe('up');
  });

  it('says nothing for a first value, the same value, or not a number', () => {
    expect(moved(null, '1.00')).toBeNull();
    expect(moved('1.0', '1.00')).toBeNull();
    expect(moved('-0.00', '0')).toBeNull();
    expect(moved('1.00', '—')).toBeNull();
  });
});
