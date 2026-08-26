import { describe, expect, it } from 'vitest';
import { TickWindow, windowOf } from './tick-window';
import type { Tick } from './types';

const tick = (bid: string, ask: string, symbol = 'XAUUSD'): Tick => ({
  symbol,
  bid,
  ask,
  timestamp: 1_700_000_000_000,
  volume: '1',
});

/**
 * The window is what stops a fast market from hiding a stop level. Its whole job
 * is to remember the extremes, so those are what is asserted.
 */
describe('TickWindow', () => {
  it('reports a single tick as its own extremes', () => {
    const window = new TickWindow();
    window.observe(tick('2000.00', '2000.20'));
    const drained = window.drain('XAUUSD');
    expect(drained).toMatchObject({
      minBid: '2000.00',
      maxBid: '2000.00',
      minAsk: '2000.20',
      maxAsk: '2000.20',
      observed: 1,
    });
  });

  it('keeps the extremes across a burst, not just the last price', () => {
    const window = new TickWindow();
    window.observe(tick('2000.00', '2000.20'));
    window.observe(tick('1990.00', '1990.20')); // the spike a dropped tick would hide
    window.observe(tick('2005.00', '2005.20'));
    window.observe(tick('2001.00', '2001.20'));

    const drained = window.drain('XAUUSD');
    expect(drained?.minBid).toBe('1990.00');
    expect(drained?.maxBid).toBe('2005.00');
    expect(drained?.minAsk).toBe('1990.20');
    expect(drained?.maxAsk).toBe('2005.20');
    expect(drained?.observed).toBe(4);
  });

  it('carries the most recent tick as `latest`, whatever the extremes were', () => {
    const window = new TickWindow();
    window.observe(tick('1990.00', '1990.20'));
    window.observe(tick('2001.00', '2001.20'));
    // Execution happens at the current price; the extreme has already passed.
    expect(window.drain('XAUUSD')?.latest.bid).toBe('2001.00');
  });

  it('keeps symbols apart', () => {
    const window = new TickWindow();
    window.observe(tick('2000.00', '2000.20', 'XAUUSD'));
    window.observe(tick('1.0800', '1.0801', 'EURUSD'));
    expect(window.size).toBe(2);
    expect(window.drain('EURUSD')?.minBid).toBe('1.0800');
    expect(window.drain('XAUUSD')?.minBid).toBe('2000.00');
  });

  /**
   * Draining empties the window, so a pass that finds nothing new stops rather
   * than re-evaluating prices it has already acted on.
   */
  it('empties on drain', () => {
    const window = new TickWindow();
    window.observe(tick('2000.00', '2000.20'));
    expect(window.drain('XAUUSD')).not.toBeNull();
    expect(window.drain('XAUUSD')).toBeNull();
    expect(window.has('XAUUSD')).toBe(false);
  });

  it('returns null for a symbol that never ticked', () => {
    expect(new TickWindow().drain('BTCUSD')).toBeNull();
  });

  /** Memory is O(symbols), not O(ticks) — the point of coalescing. */
  it('holds one window per symbol however many ticks arrive', () => {
    const window = new TickWindow();
    for (let i = 0; i < 10_000; i += 1) {
      window.observe(tick(String(2000 + (i % 50)), String(2000.2 + (i % 50))));
    }
    expect(window.size).toBe(1);
    expect(window.drain('XAUUSD')?.observed).toBe(10_000);
  });

  it('compares numerically, not as strings', () => {
    const window = new TickWindow();
    // '9.00' sorts after '10.00' lexically but is the lower price.
    window.observe(tick('10.00', '10.02'));
    window.observe(tick('9.00', '9.02'));
    expect(window.drain('XAUUSD')?.minBid).toBe('9.00');
  });
});

describe('windowOf', () => {
  it('presents one tick as a window, for the paths that expect a range', () => {
    expect(windowOf(tick('2000.00', '2000.20'))).toMatchObject({
      minBid: '2000.00',
      maxBid: '2000.00',
      observed: 1,
    });
  });
});
