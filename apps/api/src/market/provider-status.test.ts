import { describe, expect, it } from 'vitest';
import { ProviderStatusBook, describe as reason } from './provider-status';

describe('the live sources’ status', () => {
  it('follows a source through connect, traffic, loss and reconnect', () => {
    const book = new ProviderStatusBook();
    book.register('fastforex', ['XAUUSD', 'EURUSD'], 1_000);
    book.connected('fastforex', 2_000);
    book.message('fastforex', 2_500);
    book.tick('fastforex', 2_400, 2_500);
    book.disconnected('fastforex', 3_000, new Error('HTTP 429'));
    book.connecting('fastforex', 4_000);
    expect(book.snapshot()).toEqual([
      {
        name: 'fastforex',
        symbols: ['EURUSD', 'XAUUSD'],
        state: 'connecting',
        since: 4_000,
        lastMessageAt: 2_500,
        lastTickAt: 2_500,
        lastSourceTime: 2_400,
        ticks: 1,
        reconnects: 1,
        lastError: 'HTTP 429',
      },
    ]);
  });

  it('never records an address, which may carry a key', () => {
    expect(
      reason(new Error('fetch failed: https://api.fastforex.io/fx/quote?api_key=SECRET')),
    ).toBe('fetch failed: <url>');
    expect(reason('wss://ws.twelvedata.com/v1/quotes/price?apikey=SECRET closed')).toBe(
      '<url> closed',
    );
  });
});
