import { describe, expect, it } from 'vitest';
import { ConnectionMonitor, DEFAULT_MONITOR_OPTIONS } from './connection-monitor';
import { ConnectionState, type AdapterHealth } from './types';

const T0 = new Date('2026-09-03T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const healthy = (overrides: Partial<AdapterHealth> = {}): AdapterHealth => ({
  state: ConnectionState.CONNECTED,
  latencyMs: 20,
  lastQuoteAt: null,
  lastOrderEventAt: null,
  detail: null,
  ...overrides,
});
const OPTIONS = {
  ...DEFAULT_MONITOR_OPTIONS,
  openAfterFailures: 3,
  backoffBaseMs: 5_000,
  backoffCapMs: 60_000,
  heartbeatStaleMs: 30_000,
  quoteStaleMs: 60_000,
};

describe('ConnectionMonitor', () => {
  it('starts UNKNOWN, and a healthy report makes it CONNECTED with a history line', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    expect(monitor.snapshot().state).toBe('UNKNOWN');
    expect(monitor.mayTrade(T0)).toBe(false);
    monitor.healthReported(healthy(), at(0));
    expect(monitor.snapshot().state).toBe('CONNECTED');
    expect(monitor.mayTrade(at(0))).toBe(true);
    expect(monitor.history()).toEqual([
      { from: 'UNKNOWN', to: 'CONNECTED', reason: 'healthy', at: at(0) },
    ]);
  });

  it('opens the breaker after the configured failures, with doubling backoff, and a success resets it', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.healthReported(healthy(), at(0));
    monitor.failed('TIMEOUT', 'no answer', at(1));
    monitor.failed('TIMEOUT', 'no answer', at(2));
    expect(monitor.mayAttempt(at(2))).toBe(true);
    expect(monitor.snapshot().state).toBe('DISCONNECTED');

    monitor.failed('TIMEOUT', 'no answer', at(3));
    // Third failure: open for the base (5 s).
    expect(monitor.mayAttempt(at(3))).toBe(false);
    expect(monitor.mayTrade(at(3))).toBe(false);
    expect(monitor.snapshot().circuitOpenUntil).toEqual(at(8));
    expect(monitor.mayAttempt(at(8))).toBe(true);

    // Still failing after the wait: the next opening waits twice as long.
    monitor.failed('TIMEOUT', 'no answer', at(8));
    expect(monitor.snapshot().circuitOpenUntil).toEqual(at(18));
    monitor.failed('TIMEOUT', 'no answer', at(18));
    expect(monitor.snapshot().circuitOpenUntil).toEqual(at(38));

    // A success clears everything.
    monitor.healthReported(healthy(), at(40));
    expect(monitor.snapshot()).toMatchObject({
      state: 'CONNECTED',
      consecutiveFailures: 0,
      openings: 0,
      circuitOpenUntil: null,
      lastError: null,
    });
  });

  it('caps the backoff', () => {
    const monitor = new ConnectionMonitor({ ...OPTIONS, openAfterFailures: 1 });
    let t = 0;
    for (let i = 0; i < 10; i += 1) {
      monitor.failed('TIMEOUT', 'x', at(t));
      const until = monitor.snapshot().circuitOpenUntil!;
      t = (until.getTime() - T0.getTime()) / 1000;
    }
    expect(monitor.snapshot().openings).toBe(10);
    // 5, 10, 20, 40, then the 60 s cap six times.
    expect(t).toBe(5 + 10 + 20 + 40 + 60 * 6);
  });

  it('opens at once and for the cap on AUTH_FAILED: retrying the same credentials cannot help', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.healthReported(healthy(), at(0));
    monitor.failed('AUTH_FAILED', 'refused', at(1));
    expect(monitor.snapshot().state).toBe('AUTH_FAILED');
    expect(monitor.mayAttempt(at(1))).toBe(false);
    expect(monitor.snapshot().circuitOpenUntil).toEqual(at(61));
    expect(monitor.mayTrade(at(61))).toBe(false); // may attempt, may not trade
  });

  it("honours the venue's retry-after on RATE_LIMITED", () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.healthReported(healthy(), at(0));
    monitor.failed('RATE_LIMITED', 'slow down', at(1), 2_500);
    expect(monitor.snapshot().state).toBe('RATE_LIMITED');
    expect(monitor.snapshot().circuitOpenUntil).toEqual(new Date(at(1).getTime() + 2_500));
    monitor.healthReported(healthy({ state: ConnectionState.RATE_LIMITED }), at(5));
    expect(monitor.snapshot().state).toBe('RATE_LIMITED');
  });

  it('degrades on a stale heartbeat or a stale quote, and a fresh quote brings it back', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.healthReported(healthy({ lastQuoteAt: at(0) }), at(0));
    expect(monitor.snapshot().state).toBe('CONNECTED');

    monitor.tick(at(31)); // heartbeat 31 s old > 30 s
    expect(monitor.snapshot().state).toBe('DEGRADED');
    expect(monitor.mayTrade(at(31))).toBe(true); // degraded still trades

    monitor.healthReported(healthy({ lastQuoteAt: at(0) }), at(32)); // heartbeat fresh, quote still 32 s old
    expect(monitor.snapshot().state).toBe('CONNECTED');
    monitor.tick(at(61)); // quote 61 s old > 60 s, heartbeat 29 s old
    expect(monitor.snapshot().state).toBe('DEGRADED');
    // A fresh quote alone does not clear a heartbeat that is now 31 s stale…
    monitor.quoteSeen(at(63));
    expect(monitor.snapshot().state).toBe('DEGRADED');
    // …a health report does.
    monitor.healthReported(healthy(), at(63));
    expect(monitor.snapshot().state).toBe('CONNECTED');
    // And a quote alone does clear a quote-only staleness.
    monitor.tick(at(124)); // quote 61 s old, heartbeat 61 s old
    expect(monitor.snapshot().state).toBe('DEGRADED');
    monitor.healthReported(healthy(), at(125)); // heartbeat fresh, quote 62 s old
    expect(monitor.snapshot().state).toBe('DEGRADED');
    monitor.quoteSeen(at(126));
    expect(monitor.snapshot().state).toBe('CONNECTED');
  });

  it('keeps the latest of two timestamps, never an older one', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.healthReported(healthy({ lastQuoteAt: at(10), lastOrderEventAt: at(10) }), at(10));
    monitor.healthReported(healthy({ lastQuoteAt: at(5), lastOrderEventAt: at(20) }), at(11));
    expect(monitor.snapshot().lastQuoteAt).toEqual(at(10));
    expect(monitor.snapshot().lastOrderEventAt).toEqual(at(20));
  });

  it('restores from a saved snapshot as UNKNOWN, keeping the breaker', () => {
    const monitor = ConnectionMonitor.restore(
      { consecutiveFailures: 5, openings: 2, circuitOpenUntil: at(100), lastError: 'TIMEOUT: x' },
      OPTIONS,
    );
    expect(monitor.snapshot().state).toBe('UNKNOWN');
    expect(monitor.mayAttempt(at(50))).toBe(false);
    expect(monitor.mayAttempt(at(100))).toBe(true);
  });

  it('never says a trader breached anything: a timeout is a timeout', () => {
    const monitor = new ConnectionMonitor(OPTIONS);
    monitor.failed('TIMEOUT', 'x', at(0));
    const words = JSON.stringify(monitor.snapshot()) + JSON.stringify(monitor.history());
    expect(/breach|violat|fail(ed)? the/i.test(words)).toBe(false);
  });
});
