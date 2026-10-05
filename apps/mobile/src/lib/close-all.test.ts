import { describe, expect, it } from 'vitest';
import { closeAllKey, closeAllQuestion, closeAllReport } from './close-all';

describe('close all, on the phone', () => {
  it('carries one key per confirmation, and a new one for a new question', () => {
    const first = closeAllKey('acc-1', 1000, 'n1');
    // The same confirmation, tapped twice or retried, is the same key.
    expect(closeAllKey('acc-1', 1000, 'n1')).toBe(first);
    // Asked again after cancelling is a new intent.
    expect(closeAllKey('acc-1', 2000, 'n2')).not.toBe(first);
    // And never shared across accounts.
    expect(closeAllKey('acc-2', 1000, 'n1')).not.toBe(first);
  });

  it('asks in words that say it is not all-or-nothing', () => {
    expect(closeAllQuestion(3)).toMatch(/^Close all 3 positions at market\?/);
    expect(closeAllQuestion(1)).toMatch(/^Close all 1 position at market\?/);
    expect(closeAllQuestion(3)).toMatch(/stays open and is listed/);
  });

  it('reports everything closed as done', () => {
    expect(
      closeAllReport({
        asked: 2,
        closed: [{ positionId: 'a' }, { positionId: 'b' }],
        refused: [],
      }),
    ).toEqual({ tone: 'done', message: 'Closed 2 of 2.', stillOpen: [] });
  });

  it('reports an empty book without claiming anything closed', () => {
    expect(closeAllReport({ asked: 0, closed: [], refused: [] }).message).toBe(
      'Nothing was open to close.',
    );
  });

  it('names the one still open, with the server’s reason', () => {
    const report = closeAllReport({
      asked: 3,
      closed: [{ positionId: 'a' }, { positionId: 'b' }],
      refused: [{ positionId: 'c', code: 'STALE_QUOTE', message: 'No fresh quote for EURUSD.' }],
    });
    expect(report.tone).toBe('partial');
    expect(report.message).toBe('Closed 2 of 3. One is still open: No fresh quote for EURUSD.');
    expect(report.stillOpen).toEqual([{ positionId: 'c', reason: 'No fresh quote for EURUSD.' }]);
  });

  it('lists several still open rather than hiding them behind a count', () => {
    const report = closeAllReport({
      asked: 3,
      closed: [{ positionId: 'a' }],
      refused: [
        { positionId: 'b', code: 'MARKET_CLOSED', message: 'XAUUSD is outside its session' },
        { positionId: 'c', code: 'STALE_QUOTE', message: 'No fresh quote' },
      ],
    });
    expect(report.tone).toBe('partial');
    expect(report.message).toMatch(/^Closed 1 of 3\. 2 are still open/);
    expect(report.stillOpen.map((one) => one.positionId)).toEqual(['b', 'c']);
  });
});
