import { describe, expect, it } from 'vitest';
import { groupDigits } from './format';

describe('groupDigits', () => {
  it('groups the whole part and keeps the fraction exactly', () => {
    expect(groupDigits('100000.00')).toBe('100,000.00');
    expect(groupDigits('-1234567.891')).toBe('-1,234,567.891');
    expect(groupDigits('999')).toBe('999');
  });
  it('leaves anything that is not a plain decimal alone', () => {
    expect(groupDigits('n/a')).toBe('n/a');
  });
});
