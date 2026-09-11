import { describe, expect, it } from 'vitest';
import type { MarketStatusDto } from '@tp/shared-types';
import { marketNotice } from './market-state';

const NOW = Date.UTC(2026, 8, 12, 12, 0);
const status = (over: Partial<MarketStatusDto>): MarketStatusDto => ({
  state: 'CLOSED',
  tradeable: false,
  opensAt: null,
  closesAt: null,
  ...over,
});

describe('marketNotice', () => {
  it('says nothing extra about an open market', () => {
    expect(marketNotice(status({ state: 'OPEN', tradeable: true }), 'XAUUSD', NOW)).toEqual({
      label: 'open',
      detail: null,
    });
  });

  it('counts down in minutes, then hours, then names the day', () => {
    const detail = (minutes: number) =>
      marketNotice(status({ opensAt: NOW + minutes * 60_000 }), 'XAUUSD', NOW).detail;
    expect(detail(12)).toContain('Opens in 12m.');
    expect(detail(200)).toContain('Opens in 3h 20m.');
    expect(detail(180)).toContain('Opens in 3h.');
    expect(detail(60 * 34)).toMatch(/Opens \w+ at /);
  });

  /** A countdown that has run out must not count backwards. */
  it('does not show a negative countdown when the open has just passed', () => {
    expect(marketNotice(status({ opensAt: NOW - 30_000 }), 'XAUUSD', NOW).detail).toContain(
      'Opening now.',
    );
  });

  /**
   * The rule that keeps the screen honest: a state with no opening time never
   * gets one invented for it.
   */
  it('never offers a time the platform does not have', () => {
    for (const state of ['HALTED', 'UNKNOWN', 'CLOSED'] as const) {
      const detail = marketNotice(status({ state, opensAt: null }), 'XAUUSD', NOW).detail ?? '';
      expect(detail, state).not.toMatch(/Opens in|Opens \w+ at/);
      expect(detail.length, state).toBeGreaterThan(0);
    }
  });

  it('tells a halt apart from a closed market, and both from an unconfigured one', () => {
    expect(marketNotice(status({ state: 'HALTED' }), 'XAUUSD', NOW).detail).toContain(
      'can still be closed',
    );
    expect(marketNotice(status({ state: 'UNKNOWN' }), 'NEWCOIN', NOW).detail).toContain(
      'no trading session configured',
    );
    expect(
      marketNotice(status({ state: 'PRE_OPEN', opensAt: NOW + 600_000 }), 'X', NOW).detail,
    ).toContain('has not opened yet');
  });

  it('gives every state a short badge word', () => {
    const labels = (['OPEN', 'PRE_OPEN', 'POST_CLOSE', 'CLOSED', 'HALTED', 'UNKNOWN'] as const).map(
      (state) => marketNotice(status({ state }), 'X', NOW).label,
    );
    expect(new Set(labels).size).toBe(6);
    for (const label of labels) expect(label).toMatch(/^[a-z -]{1,12}$/);
  });
});
