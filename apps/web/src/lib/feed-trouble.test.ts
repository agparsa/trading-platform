import { describe, expect, it } from 'vitest';
import type { MarketProviderRow } from './admin-queries';
import { feedTrouble } from './feed-trouble';

const row = (over: Partial<MarketProviderRow>): MarketProviderRow => ({
  name: 'fastforex',
  symbols: ['EURUSD', 'XAUUSD'],
  state: 'connected',
  since: 1,
  lastMessageAt: null,
  lastTickAt: null,
  lastSourceTime: null,
  ticks: 0,
  reconnects: 0,
  lastError: null,
  ...over,
});

describe('feedTrouble', () => {
  it('names a source that was refused or dropped, with its error', () => {
    expect(feedTrouble([row({ state: 'connecting', lastError: 'HTTP 401' })])).toEqual([
      { name: 'fastforex', symbols: ['EURUSD', 'XAUUSD'], error: 'HTTP 401', since: 1 },
    ]);
    expect(feedTrouble([row({ state: 'disconnected' })])).toHaveLength(1);
  });

  it('is quiet for a connected source, and for one connecting that has not failed', () => {
    expect(feedTrouble([row({}), row({ state: 'connecting' })])).toEqual([]);
    expect(feedTrouble([row({ lastError: 'HTTP 500' })])).toEqual([]);
  });
});
