import { describe, expect, it } from 'vitest';
import { WsEvent, type PnlUpdatePayload } from '@tp/shared-types';
import { NO_VERSIONS, applyAccount, applyPnl, bump, topicsOf } from './live-book';

const row = (id: string) => ({
  id,
  symbol: 'EURUSD',
  currentPrice: '1.1000',
  floatingPnl: '0.00',
  netFloatingPnl: '-0.35',
  stale: false as boolean | null,
});
const marked = (positionId: string, floatingPnl: string): PnlUpdatePayload => ({
  accountId: 'a',
  positionId,
  symbol: 'EURUSD',
  floatingPnl,
  netPnl: `${floatingPnl}-net`,
  currentPrice: '1.1010',
  stale: false,
});

describe('which lists a frame makes stale', () => {
  it('refetches the book and the account after a fill, which opens a position the frame does not carry', () => {
    expect([...topicsOf(WsEvent.ORDER_FILLED)].sort()).toEqual(['account', 'orders', 'positions']);
  });

  it('refetches the account and the history after a close, whose realised P&L no frame carries', () => {
    expect([...topicsOf(WsEvent.POSITION_CLOSED)].sort()).toEqual([
      'account',
      'positions',
      'trades',
    ]);
  });

  it('refetches the orders after a refusal, so a refused order stops showing as working', () => {
    expect(topicsOf(WsEvent.ORDER_REJECTED)).toEqual(['orders']);
  });

  it('refetches nothing for the frames that carry their own figures', () => {
    for (const event of [WsEvent.ACCOUNT_UPDATED, WsEvent.PNL_UPDATED, WsEvent.QUOTES_UPDATED]) {
      expect(topicsOf(event)).toEqual([]);
    }
  });

  it('refetches nothing for an event it has never heard of', () => {
    expect(topicsOf('margin.call')).toEqual([]);
  });

  it('moves each named counter once, and leaves the object alone when none is named', () => {
    const once = bump(NO_VERSIONS, ['orders', 'orders', 'positions']);
    expect(once).toEqual({ orders: 1, positions: 1, account: 0, trades: 0 });
    expect(bump(once, [])).toBe(once);
  });
});

describe('laying P&L over the rows', () => {
  it('marks the rows the frame names, under the name REST uses', () => {
    const rows = [row('p1'), row('p2')];
    const next = applyPnl(rows, [marked('p2', '12.50')]);
    expect(next?.[0]).toBe(rows[0]);
    expect(next?.[1]).toMatchObject({
      floatingPnl: '12.50',
      netFloatingPnl: '12.50-net',
      currentPrice: '1.1010',
    });
  });

  it('does not invent a row for a position the list does not have', () => {
    const rows = [row('p1')];
    expect(applyPnl(rows, [marked('p9', '1.00')])).toBe(rows);
  });

  it('keeps null a null: no fresh price is not a price', () => {
    const next = applyPnl(
      [row('p1')],
      [{ ...marked('p1', '0.00'), currentPrice: null, stale: true }],
    );
    expect(next?.[0]).toMatchObject({ currentPrice: null, stale: true });
  });

  it('leaves a list that has not loaded as not loaded', () => {
    expect(applyPnl(null, [marked('p1', '1.00')])).toBeNull();
  });
});

describe('laying an account frame over the snapshot', () => {
  const snapshot = {
    accountId: 'a',
    equity: '100.00',
    realizedPnlToday: '5.00',
    updatedAt: 10,
  };

  it('takes the figures from the frame and the realised P&L from the snapshot', () => {
    expect(applyAccount(snapshot, { accountId: 'a', equity: '101.00', updatedAt: 11 })).toEqual({
      ...snapshot,
      equity: '101.00',
      updatedAt: 11,
    });
  });

  it("does not show another account's figures", () => {
    expect(applyAccount(snapshot, { accountId: 'b', equity: '1.00', updatedAt: 11 })).toBe(
      snapshot,
    );
  });

  it('does not let an older frame overwrite a newer snapshot', () => {
    expect(applyAccount(snapshot, { accountId: 'a', equity: '99.00', updatedAt: 9 })).toBe(
      snapshot,
    );
  });
});
