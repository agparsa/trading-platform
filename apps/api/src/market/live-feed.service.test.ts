import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tick } from '@tp/market-core';
import { LiveFeedService, type LiveSocket } from './live-feed.service';

/**
 * The live feed, against a socket that is a plain object. What is pinned: a
 * venue's quote reaches the sink as the platform's tick; a covered instrument
 * stays covered while the socket is down; a dropped socket is reconnected and
 * never mistaken for a market event; the key is in no log line.
 */
function fakeSocket(): LiveSocket & { sent: string[]; closed: boolean } {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    closed: false,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

function service(env: Record<string, string>) {
  const config = new ConfigService<Record<string, unknown>, true>({
    MARKET_LIVE_BINANCE: '',
    MARKET_LIVE_BINANCE_URL: 'wss://data-stream.binance.vision',
    MARKET_LIVE_TWELVEDATA: '',
    TWELVEDATA_API_KEY: '',
    ...env,
  } as never);
  const live = new LiveFeedService(config as never);
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  const urls: string[] = [];
  live.socketFactory = (url) => {
    urls.push(url);
    const socket = fakeSocket();
    sockets.push(socket);
    return socket;
  };
  const precision = (code: string) => ({ BTCUSD: 2, ETHUSD: 2, XAUUSD: 2 })[code];
  live.configure(precision, () => undefined);
  return { live, sockets, urls };
}

afterEach(() => vi.useRealTimers());

describe('the live price feed', () => {
  it('is off, and covers nothing, until a source is configured', () => {
    const { live, sockets } = service({});
    live.start(async () => undefined);
    expect(sockets).toHaveLength(0);
    expect(live.covers('BTCUSD')).toBe(false);
    expect(live.describe()).toBe('none');
  });

  it("hands a venue's quote to the sink as the platform's tick", async () => {
    const { live, sockets, urls } = service({
      MARKET_LIVE_BINANCE: 'BTCUSD:btcusdt,ETHUSD:ethusdt',
    });
    const seen: Tick[] = [];
    live.start(async (tick) => void seen.push(tick));
    expect(urls[0]).toBe(
      'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker',
    );
    sockets[0]!.onopen?.({});
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        stream: 'btcusdt@bookTicker',
        data: { s: 'BTCUSDT', b: '77634.99', a: '77635.01' },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ symbol: 'BTCUSD', bid: '77634.99', ask: '77635.01' });
  });

  it('ignores an instrument the platform does not have', () => {
    const { live } = service({ MARKET_LIVE_BINANCE: 'BTCUSD:btcusdt,DOGEUSD:dogeusdt' });
    expect(live.covers('BTCUSD')).toBe(true);
    expect(live.covers('DOGEUSD')).toBe(false);
  });

  it('keeps an instrument covered while its socket is down, and reconnects', () => {
    vi.useFakeTimers();
    const { live, sockets } = service({ MARKET_LIVE_BINANCE: 'BTCUSD:btcusdt' });
    live.start(async () => undefined);
    sockets[0]!.onclose?.({});
    // Down: still the live source's instrument, so the simulator stays out.
    expect(live.covers('BTCUSD')).toBe(true);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('does not reconnect after it is stopped', () => {
    vi.useFakeTimers();
    const { live, sockets } = service({ MARKET_LIVE_BINANCE: 'BTCUSD:btcusdt' });
    live.start(async () => undefined);
    live.stop();
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('subscribes to Twelve Data only with a key, and never describes the key', () => {
    const without = service({ MARKET_LIVE_TWELVEDATA: 'XAUUSD:XAU/USD' });
    expect(without.live.covers('XAUUSD')).toBe(false);

    const { live, sockets, urls } = service({
      MARKET_LIVE_TWELVEDATA: 'XAUUSD:XAU/USD',
      TWELVEDATA_API_KEY: 'test-key-123',
    });
    live.start(async () => undefined);
    sockets[0]!.onopen?.({});
    expect(urls[0]).toContain('apikey=test-key-123');
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      action: 'subscribe',
      params: { symbols: 'XAU/USD' },
    });
    expect(live.describe()).toBe('twelvedata (XAUUSD)');
    expect(live.describe()).not.toContain('test-key-123');
    live.stop();
  });
});
