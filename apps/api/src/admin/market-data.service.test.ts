import { describe, expect, it } from 'vitest';
import type { Tick } from '@tp/market-core';
import { MarketDataAdminService } from './market-data.service';
import { PROVIDER_STATUS_KEY } from '../market/provider-status';

const NOW = 1_800_000_000_000;

function build(stored: string | null, ticks: Record<string, Tick>) {
  const redis = {
    client: { get: async (key: string) => (key === PROVIDER_STATUS_KEY ? stored : null) },
  };
  const quotes = {
    latest: async (symbol: string) => ticks[symbol] ?? null,
    maxAgeMs: (symbol: string) => (symbol === 'EURUSD' ? 15_000 : 5_000),
  };
  const symbols = { codes: () => ['XAUUSD', 'EURUSD', 'BTCUSD'] };
  return new MarketDataAdminService(redis as never, quotes as never, symbols as never);
}

describe('the Market Data screen', () => {
  it('names each instrument’s source and judges its age by its own limit', async () => {
    const stored = JSON.stringify({
      at: NOW - 1_000,
      providers: [{ name: 'fastforex', symbols: ['EURUSD', 'XAUUSD'], state: 'connected' }],
    });
    const view = await build(stored, {
      EURUSD: { symbol: 'EURUSD', bid: '1.1', ask: '1.2', timestamp: NOW - 12_000, volume: '0' },
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: '3881.93',
        ask: '3886.08',
        timestamp: NOW - 12_000,
        volume: '0',
      },
    }).view(NOW);
    expect(view.reportedAt).toBe(NOW - 1_000);
    expect(view.instruments).toEqual([
      expect.objectContaining({ symbol: 'BTCUSD', source: 'none', bid: null, stale: true }),
      expect.objectContaining({
        symbol: 'EURUSD',
        source: 'fastforex',
        ageMs: 12_000,
        stale: false,
      }),
      expect.objectContaining({
        symbol: 'XAUUSD',
        source: 'fastforex',
        ageMs: 12_000,
        stale: true,
      }),
    ]);
  });

  it('says nothing is reported when the ingester has not written, rather than inventing a state', async () => {
    const view = await build(null, {}).view(NOW);
    expect(view.reportedAt).toBeNull();
    expect(view.providers).toEqual([]);
    // No price and no live source: `none`, never a claimed simulator price.
    expect(view.instruments.every((row) => row.source === 'none')).toBe(true);
  });
});
