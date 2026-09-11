import { describe, expect, it } from 'vitest';
import type { MarketStatusDto } from '@tp/shared-types';
import { marketLabel } from './market-state';

const status = (over: Partial<MarketStatusDto>): MarketStatusDto => ({
  state: 'CLOSED',
  tradeable: false,
  opensAt: null,
  closesAt: null,
  ...over,
});

describe('marketLabel', () => {
  it('tells a halt, a weekend and an unconfigured instrument apart', () => {
    expect(marketLabel(status({ state: 'HALTED' }))).toBe('trading halted');
    expect(marketLabel(status({ state: 'UNKNOWN' }))).toBe('no trading session');
    expect(marketLabel(status({ state: 'CLOSED' }))).toBe('market closed');
  });

  it('says when it opens, in the time a phone row has space for', () => {
    const now = Date.now();
    expect(marketLabel(status({ opensAt: now + 20 * 60_000 }))).toMatch(/opens in (19|20|21)m/);
    expect(marketLabel(status({ state: 'PRE_OPEN', opensAt: now + 5 * 60_000 }))).toMatch(
      /^opens in \dm$/,
    );
    expect(marketLabel(status({ opensAt: now + 5 * 3_600_000 }))).toContain('in 5h');
  });

  /** A countdown that has run out must not count backwards on a phone either. */
  it('says "now" rather than a negative countdown when the open has just passed', () => {
    expect(marketLabel(status({ opensAt: Date.now() - 30_000 }))).toBe('closed · opens now');
    expect(marketLabel(status({ state: 'PRE_OPEN', opensAt: Date.now() - 1_000 }))).toBe(
      'opens now',
    );
  });

  it('never invents an opening time it was not given', () => {
    for (const state of ['HALTED', 'UNKNOWN', 'CLOSED', 'PRE_OPEN'] as const) {
      expect(marketLabel(status({ state, opensAt: null }))).not.toMatch(/opens (in|\w+day)/);
    }
  });
});
