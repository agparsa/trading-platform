import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, delivered, nextDelayMs, shouldDisable } from './schedule';

describe('the retry schedule', () => {
  it('widens with each failure and stops at the ceiling', () => {
    const policy = { baseDelayMs: 1000, factor: 4, maxDelayMs: 20_000, maxAttempts: 6 };
    expect([1, 2, 3, 4, 5].map((n) => nextDelayMs(n, policy))).toEqual([
      1000, 4000, 16_000, 20_000, 20_000,
    ]);
  });

  it('has no next attempt after the last one', () => {
    expect(nextDelayMs(DEFAULT_RETRY.maxAttempts)).toBeNull();
    expect(nextDelayMs(DEFAULT_RETRY.maxAttempts - 1)).not.toBeNull();
  });

  it('counts attempts from one', () => {
    expect(() => nextDelayMs(0)).toThrow(/from 1/);
  });

  /** The default: eight attempts spread over roughly a day, not a minute. */
  it('spreads the default schedule over hours, not seconds', () => {
    let total = 0;
    for (let n = 1; n < DEFAULT_RETRY.maxAttempts; n += 1) total += nextDelayMs(n) ?? 0;
    expect(total).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(total).toBeLessThan(48 * 60 * 60 * 1000);
  });
});

describe('disabling an endpoint', () => {
  it('trips at the threshold and not before', () => {
    expect(shouldDisable(4, 5)).toBe(false);
    expect(shouldDisable(5, 5)).toBe(true);
  });

  it('refuses a threshold that would disable on success', () => {
    expect(() => shouldDisable(0, 0)).toThrow();
  });
});

describe('what counts as delivered', () => {
  it('is 2xx only — a redirect is not followed and not a success', () => {
    expect(delivered(200)).toBe(true);
    expect(delivered(204)).toBe(true);
    expect(delivered(299)).toBe(true);
    expect(delivered(301)).toBe(false);
    expect(delivered(302)).toBe(false);
    expect(delivered(199)).toBe(false);
    expect(delivered(404)).toBe(false);
    expect(delivered(500)).toBe(false);
  });
});
