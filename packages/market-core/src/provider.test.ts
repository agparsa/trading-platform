import { describe, expect, it } from 'vitest';
import { isTickFresh } from './provider';
import { T0, tick } from './__fixtures__/market';

describe('isTickFresh', () => {
  const t = tick(0, '4583.58', '4583.72');

  it('accepts a tick inside the freshness window', () => {
    expect(isTickFresh(t, T0 + 4_999)).toBe(true);
  });

  it('rejects a stale tick rather than trading on a dead feed', () => {
    expect(isTickFresh(t, T0 + 5_001)).toBe(false);
  });

  it('rejects a tick from the future, which means clock skew', () => {
    expect(isTickFresh(t, T0 - 1)).toBe(false);
  });

  it('honours a custom policy', () => {
    expect(isTickFresh(t, T0 + 900, { maxAgeMs: 1_000 })).toBe(true);
    expect(isTickFresh(t, T0 + 1_100, { maxAgeMs: 1_000 })).toBe(false);
  });
});
