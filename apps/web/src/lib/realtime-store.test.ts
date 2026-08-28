import { beforeEach, describe, expect, it } from 'vitest';
import { useRealtime, type AccountState } from './realtime-store';

/**
 * The store's one non-obvious rule: absent is not zero.
 *
 * Realized P&L arrives with the REST snapshot. Tick frames omit it, because
 * nothing about realized P&L changes on a tick and querying for it twice a
 * second would buy nothing. A store that treated the frame's silence as a value
 * would blank the trader's day P&L between snapshots — which reads as "your
 * profit is gone", the single most alarming thing a terminal can say by
 * accident.
 */
const base: AccountState = {
  accountId: 'a1',
  currency: 'USD',
  balance: '100000.00',
  equity: '100120.00',
  floatingPnl: '120.00',
  usedMargin: '4583.72',
  freeMargin: '95536.28',
  marginLevel: '2184.30',
  marginUtilisation: '4.58',
  grossExposure: '458372.00',
  openPositions: 1,
  updatedAt: 1,
};

const snapshot: AccountState = {
  ...base,
  realizedPnlToday: '432.10',
  realizedPnlTotal: '5120.55',
  realizedSince: 1_700_000_000_000,
};

describe('realtime store: account frames', () => {
  beforeEach(() => {
    useRealtime.setState({ account: null });
  });

  it('keeps realized P&L when a tick frame does not carry it', () => {
    useRealtime.getState().applyAccount(snapshot);
    useRealtime.getState().applyAccount({ ...base, floatingPnl: '95.00', updatedAt: 2 });

    const account = useRealtime.getState().account;
    expect(account?.floatingPnl).toBe('95.00');
    expect(account?.realizedPnlToday).toBe('432.10');
    expect(account?.realizedSince).toBe(1_700_000_000_000);
  });

  it('takes a new realized figure when a frame does carry one', () => {
    useRealtime.getState().applyAccount(snapshot);
    useRealtime.getState().applyAccount({ ...snapshot, realizedPnlToday: '500.00', updatedAt: 3 });
    expect(useRealtime.getState().account?.realizedPnlToday).toBe('500.00');
  });

  /**
   * Switching accounts must not carry one account's profit onto another's
   * strip, even for the moment before its snapshot lands. Showing the wrong
   * account's number is worse than showing none.
   */
  it('does not carry realized P&L across a change of account', () => {
    useRealtime.getState().applyAccount(snapshot);
    useRealtime.getState().applyAccount({ ...base, accountId: 'a2', updatedAt: 4 });

    const account = useRealtime.getState().account;
    expect(account?.accountId).toBe('a2');
    expect(account?.realizedPnlToday).toBeUndefined();
  });

  it('leaves it absent when no snapshot has arrived yet', () => {
    useRealtime.getState().applyAccount(base);
    expect(useRealtime.getState().account?.realizedPnlToday).toBeUndefined();
  });
});
