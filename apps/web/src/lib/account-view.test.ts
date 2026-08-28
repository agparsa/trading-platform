import { describe, expect, it } from 'vitest';
import { accountView } from './account-view';
import type { AccountStateResponse } from './queries';
import type { AccountState } from './realtime-store';

const snapshot = {
  accountId: 'a1',
  currency: 'USD',
  balance: '100000.00',
  equity: '100000.00',
  floatingPnl: '0.00',
  usedMargin: '0.00',
  freeMargin: '100000.00',
  marginLevel: null,
  marginUtilisation: '0',
  grossExposure: '0.00',
  realizedPnlToday: '-0.61',
  realizedPnlTotal: '-0.61',
  realizedSince: 1_787_788_800_000,
  openPositions: 0,
  updatedAt: 1,
  positions: [],
} satisfies AccountStateResponse;

const frame = {
  accountId: 'a1',
  currency: 'USD',
  balance: '100000.00',
  equity: '100002.59',
  floatingPnl: '3.20',
  usedMargin: '35.89',
  freeMargin: '99966.70',
  marginLevel: '278636.36',
  marginUtilisation: '0.04',
  grossExposure: '3592.10',
  openPositions: 1,
  updatedAt: 2,
} satisfies AccountState;

describe('accountView', () => {
  /**
   * The bug this function exists to prevent, and the reason it is tested here
   * rather than trusted: the header used to take the live frame whole whenever
   * one had arrived. Realized P&L then read "—" from the first tick onwards,
   * while the server had sent the figure moments earlier. It looked like a
   * missing feature and was a missing merge.
   */
  it('keeps the snapshot fields the frame does not carry', () => {
    const view = accountView('a1', snapshot, frame);
    expect(view?.realizedPnlToday).toBe('-0.61');
    expect(view?.realizedSince).toBe(1_787_788_800_000);
  });

  it('prefers the frame for everything the frame does carry', () => {
    const view = accountView('a1', snapshot, frame);
    expect(view?.equity).toBe('100002.59');
    expect(view?.floatingPnl).toBe('3.20');
    expect(view?.marginUtilisation).toBe('0.04');
    expect(view?.openPositions).toBe(1);
  });

  it('shows the snapshot alone before any frame arrives', () => {
    expect(accountView('a1', snapshot, null)?.equity).toBe('100000.00');
  });

  it('shows the frame alone before the snapshot loads', () => {
    expect(accountView('a1', undefined, frame)?.equity).toBe('100002.59');
  });

  /**
   * Switching accounts must not show one account's numbers under another's
   * name, even for the moment before the new data lands. A stale figure with
   * the wrong label is worse than an empty one.
   */
  it('ignores data belonging to a different account', () => {
    expect(accountView('a2', snapshot, frame)).toBeNull();
    expect(accountView('a2', snapshot, null)).toBeNull();
    expect(accountView(null, snapshot, frame)).toBeNull();
  });
});
