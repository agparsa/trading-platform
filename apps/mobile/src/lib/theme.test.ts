import { describe, expect, it } from 'vitest';
import { formatSigned, signColor, theme } from './theme';

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

  it('colours by sign', () => {
    expect(signColor('12')).toBe(theme.colors.positive);
    expect(signColor('-12')).toBe(theme.colors.negative);
    expect(signColor('0')).toBe(theme.colors.textMuted);
  });

  it('does not colour something that is not a number', () => {
    // A dash or an em-dash while a value is loading must not read as a loss.
    expect(signColor('—')).toBe(theme.colors.textMuted);
  });
});
