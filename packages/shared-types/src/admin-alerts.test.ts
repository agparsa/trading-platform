import { describe, expect, it } from 'vitest';
import { ADMIN_ALERT_METRICS, AdminAlertMetric, breaches, shouldRaise } from './admin-alerts';

describe('admin alert rules', () => {
  it('describes every metric once', () => {
    expect(ADMIN_ALERT_METRICS.map((row) => row.metric).sort()).toEqual(
      Object.values(AdminAlertMetric).sort(),
    );
  });

  it('compares strictly', () => {
    expect(breaches(11, 'ABOVE', 10)).toBe(true);
    expect(breaches(10, 'ABOVE', 10)).toBe(false);
    expect(breaches(1, 'ABOVE', 0)).toBe(true);
    expect(breaches(2, 'BELOW', 3)).toBe(true);
    expect(breaches(3, 'BELOW', 3)).toBe(false);
  });

  const now = new Date('2026-11-20T12:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('raises on the first breach, not again inside the quiet period, and again after it', () => {
    const base = { breached: true, cooldownMinutes: 60, now };
    expect(shouldRaise({ ...base, wasBreached: false, lastRaisedAt: ago(5) })).toBe(true);
    expect(shouldRaise({ ...base, wasBreached: true, lastRaisedAt: ago(5) })).toBe(false);
    expect(shouldRaise({ ...base, wasBreached: true, lastRaisedAt: ago(60) })).toBe(true);
    expect(shouldRaise({ ...base, wasBreached: true, lastRaisedAt: null })).toBe(true);
  });

  it('never raises when the reading is inside the line', () => {
    expect(
      shouldRaise({
        breached: false,
        wasBreached: true,
        lastRaisedAt: null,
        cooldownMinutes: 0,
        now,
      }),
    ).toBe(false);
  });
});
