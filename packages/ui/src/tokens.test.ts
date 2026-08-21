import { describe, expect, it } from 'vitest';
import { toneOf } from './tokens';

describe('toneOf', () => {
  it('classifies signed values', () => {
    expect(toneOf('136.94')).toBe('profit');
    expect(toneOf('-236.34')).toBe('loss');
  });

  it('treats anything that rounds to zero as flat, sign included', () => {
    expect(toneOf('0')).toBe('flat');
    expect(toneOf('0.00')).toBe('flat');
    expect(toneOf('-0.00')).toBe('flat');
  });

  it('treats unparseable input as flat rather than guessing', () => {
    expect(toneOf('')).toBe('flat');
    expect(toneOf('n/a')).toBe('flat');
  });
});
