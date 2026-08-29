import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@tp/api-client';
import { buildChartDatafeed, storeBarSource } from './chart-datafeed';
import { useRealtime } from './realtime-store';
import type { SymbolRow, TradingSession } from './queries';

/**
 * The adapter, driven end to end.
 *
 * `tradingview-datafeed.test.ts` proves the mappings — seconds against
 * milliseconds, price scale, session strings. This proves the assembled object:
 * that `getBars` reaches the API with the window it worked out, that
 * `subscribeBars` delivers the bars the realtime store receives, and that
 * unsubscribing stops it.
 *
 * That matters because the licensed charting bundle is not in this repository.
 * Nothing renders from this adapter yet, so nothing else would notice if it were
 * wired up wrong — and "written" is not "works".
 */

const XAUUSD: SymbolRow = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '5',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
};

const SESSION: TradingSession = {
  symbol: 'XAUUSD',
  timezone: 'Etc/UTC',
  windows: [{ day: 1, openMinute: 0, closeMinute: 1440 }],
};

interface Requested {
  path: string;
  query: Record<string, unknown>;
}

function stubApi(bars: unknown[], seen: Requested[]): ApiClient {
  return {
    get: async (path: string, options?: { query?: Record<string, unknown> }) => {
      seen.push({ path, query: options?.query ?? {} });
      return bars;
    },
  } as unknown as ApiClient;
}

const MINUTE = 60_000;
const BASE = 1_756_000_000_000 - (1_756_000_000_000 % MINUTE);

const candle = (time: number, close: string) => ({
  time,
  open: '4583.00',
  high: '4584.00',
  low: '4582.00',
  close,
  volume: '10',
});

describe('buildChartDatafeed', () => {
  beforeEach(() => {
    useRealtime.getState().clearBars();
  });

  it('reports the configuration the library asks for on start-up', async () => {
    const feed = buildChartDatafeed({
      api: stubApi([], []),
      symbols: () => [XAUUSD],
      sessionFor: () => SESSION,
    });

    const config = await new Promise<{ supported_resolutions: string[] }>((resolve) => {
      feed.onReady(resolve);
    });
    expect(config.supported_resolutions).toContain('1');
  });

  it('resolves an instrument with the session the platform holds for it', async () => {
    const feed = buildChartDatafeed({
      api: stubApi([], []),
      symbols: () => [XAUUSD],
      sessionFor: () => SESSION,
    });

    const info = await new Promise<{ ticker: string; session: string; pricescale: number }>(
      (resolve, reject) => {
        feed.resolveSymbol('Trading Platform:XAUUSD', resolve, reject);
      },
    );
    expect(info.ticker).toBe('XAUUSD');
    expect(info.pricescale).toBe(100);
    // Day 1 here is Monday; the library counts Sunday as 1, so it shifts to 2.
    expect(info.session).toBe('0000-2400:2');
  });

  it('refuses an instrument nobody has', async () => {
    const feed = buildChartDatafeed({
      api: stubApi([], []),
      symbols: () => [XAUUSD],
      sessionFor: () => null,
    });
    const reason = await new Promise<string>((resolve) => {
      feed.resolveSymbol('NOPE', () => resolve('resolved'), resolve);
    });
    expect(reason).toBe('unknown_symbol');
  });

  /**
   * The unit trap this whole adapter exists to get right: the library asks in
   * seconds and every bar on this platform's wire is in milliseconds.
   */
  it('asks the API in milliseconds for a request made in seconds', async () => {
    const seen: Requested[] = [];
    const feed = buildChartDatafeed({
      api: stubApi([candle(BASE, '4583.50')], seen),
      symbols: () => [XAUUSD],
      sessionFor: () => SESSION,
    });

    const toSeconds = Math.floor((BASE + MINUTE) / 1000);
    const bars = await new Promise<Array<{ time: number; close: number }>>((resolve, reject) => {
      void feed.getBars(
        { ticker: 'XAUUSD' } as never,
        '1',
        { from: toSeconds - 300 * 60, to: toSeconds, countBack: 300, firstDataRequest: true },
        (rows) => resolve(rows),
        reject,
      );
    });

    expect(seen[0]?.path).toBe('/market/candles');
    expect(Number(seen[0]?.query['to'])).toBe(toSeconds * 1000);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.time).toBe(BASE);
    expect(bars[0]?.close).toBe(4583.5);
  });

  it('reports an API failure to the library rather than swallowing it', async () => {
    const failing = {
      get: async () => {
        throw new Error('candles are down');
      },
    } as unknown as ApiClient;
    const feed = buildChartDatafeed({
      api: failing,
      symbols: () => [XAUUSD],
      sessionFor: () => SESSION,
    });

    const reason = await new Promise<string>((resolve) => {
      void feed.getBars(
        { ticker: 'XAUUSD' } as never,
        '1',
        { from: 0, to: 1, countBack: 1, firstDataRequest: true },
        () => resolve('called back with bars'),
        resolve,
      );
    });
    expect(reason).toBe('candles are down');
  });
});

describe('storeBarSource', () => {
  beforeEach(() => {
    useRealtime.getState().clearBars();
  });

  it('delivers bars the socket put in the store', () => {
    const seen: Array<{ time: number; close: string }> = [];
    const stop = storeBarSource().subscribe('XAUUSD', '1', (bar) => seen.push(bar));

    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.50'), symbol: 'XAUUSD', resolution: '1' });
    useRealtime
      .getState()
      .applyBar({ ...candle(BASE + MINUTE, '4584.10'), symbol: 'XAUUSD', resolution: '1' });

    stop();
    expect(seen.map((bar) => bar.close)).toEqual(['4583.50', '4584.10']);
  });

  it('delivers an update to the bar in progress', () => {
    const seen: string[] = [];
    const stop = storeBarSource().subscribe('XAUUSD', '1', (bar) => seen.push(bar.close));

    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.50'), symbol: 'XAUUSD', resolution: '1' });
    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.90'), symbol: 'XAUUSD', resolution: '1' });

    stop();
    expect(seen).toEqual(['4583.50', '4583.90']);
  });

  /**
   * zustand notifies on every store change. Without the guard, a quote arriving
   * four times a second would re-emit a bar the chart already has.
   */
  it('says nothing when an unrelated part of the store changes', () => {
    const seen: string[] = [];
    const stop = storeBarSource().subscribe('XAUUSD', '1', (bar) => seen.push(bar.close));

    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.50'), symbol: 'XAUUSD', resolution: '1' });
    useRealtime
      .getState()
      .applyQuote({
        symbol: 'XAUUSD',
        bid: '4583.58',
        ask: '4583.72',
        spread: '0.14',
        timestamp: 1,
      });

    stop();
    expect(seen).toEqual(['4583.50']);
  });

  it('ignores another instrument and another resolution', () => {
    const seen: string[] = [];
    const stop = storeBarSource().subscribe('XAUUSD', '1', (bar) => seen.push(bar.close));

    useRealtime.getState().applyBar({ ...candle(BASE, '1.08'), symbol: 'EURUSD', resolution: '1' });
    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.50'), symbol: 'XAUUSD', resolution: '15' });

    stop();
    expect(seen).toEqual([]);
  });

  it('stops delivering once unsubscribed', () => {
    const onBar = vi.fn();
    const stop = storeBarSource().subscribe('XAUUSD', '1', onBar);
    stop();
    useRealtime
      .getState()
      .applyBar({ ...candle(BASE, '4583.50'), symbol: 'XAUUSD', resolution: '1' });
    expect(onBar).not.toHaveBeenCalled();
  });
});
