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

describe('the OANDA source', () => {
  const LINE =
    '{"asks":[{"liquidity":10000000,"price":"4012.37"}],"bids":[{"liquidity":10000000,"price":"4012.05"}],"instrument":"XAU_USD","status":"tradeable","time":"2026-11-14T10:00:00.123456789Z"}';

  it('streams the mapped instruments with the token in a header, and ingests a price', async () => {
    const { live } = service({
      MARKET_LIVE_OANDA: 'XAUUSD:XAU_USD',
      OANDA_API_KEY: 'secret-token-123',
      OANDA_ACCOUNT_ID: '101-004-1-001',
      OANDA_ENVIRONMENT: 'practice',
    });
    const opened: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const socket = fakeSocket();
    live.streamFactory = (url, headers) => {
      opened.push({ url, headers });
      return socket;
    };
    const ticks: Tick[] = [];
    live.start(async (tick) => void ticks.push(tick));
    expect(opened[0]?.url).toBe(
      'https://stream-fxpractice.oanda.com/v3/accounts/101-004-1-001/pricing/stream?instruments=XAU_USD',
    );
    expect(opened[0]?.headers).toEqual({ Authorization: 'Bearer secret-token-123' });
    expect(live.covers('XAUUSD')).toBe(true);
    expect(live.describe()).not.toContain('secret-token-123');
    socket.onopen?.({});
    socket.onmessage?.({ data: LINE });
    await Promise.resolve();
    expect(ticks).toEqual([
      expect.objectContaining({ symbol: 'XAUUSD', bid: '4012.05', ask: '4012.37' }),
    ]);
    live.stop();
  });

  it('stays off, saying why, without a token or an account', () => {
    const { live } = service({ MARKET_LIVE_OANDA: 'XAUUSD:XAU_USD', OANDA_API_KEY: '' });
    expect(live.covers('XAUUSD')).toBe(false);
  });

  it('uses the live host for a live account', () => {
    const { live } = service({
      MARKET_LIVE_OANDA: 'XAUUSD:XAU_USD',
      OANDA_API_KEY: 'k',
      OANDA_ACCOUNT_ID: '001-001-1-001',
      OANDA_ENVIRONMENT: 'live',
    });
    const urls: string[] = [];
    live.streamFactory = (url) => {
      urls.push(url);
      return fakeSocket();
    };
    live.start(async () => undefined);
    expect(urls[0]).toMatch(/^https:\/\/stream-fxtrade\.oanda\.com\//);
    live.stop();
  });
});

describe('the fastFOREX source', () => {
  const FX =
    '{"quotes":{"EURUSD":{"bid":"1.10214","ask":"1.1025","tsp":"1794613872987","size":1}},"ms":3}';

  it('polls fx and metals separately with the key in a header, and ingests each quote once', async () => {
    const { live } = service({
      MARKET_LIVE_FASTFOREX: 'XAUUSD:XAUUSD,BTCUSD:EURUSD',
      FASTFOREX_API_KEY: 'ff-secret',
      FASTFOREX_BASE_URL: 'https://api.fastforex.io',
      FASTFOREX_POLL_MS: 6000 as never,
      FASTFOREX_MONTHLY_QUOTA: 1_000_000 as never,
    });
    const polls: Array<{
      urls: readonly string[];
      headers: Readonly<Record<string, string>>;
      interval: number;
    }> = [];
    const socket = fakeSocket();
    live.pollFactory = (urls, headers, interval) => {
      polls.push({ urls, headers, interval });
      return socket;
    };
    const ticks: Tick[] = [];
    live.start(async (tick) => void ticks.push(tick));
    expect(polls[0]).toEqual({
      urls: [
        'https://api.fastforex.io/fx/quote?pairs=EURUSD',
        'https://api.fastforex.io/metals/quote?instruments=XAUUSD',
      ],
      headers: { 'X-API-Key': 'ff-secret' },
      interval: 6000,
    });
    expect(live.describe()).not.toContain('ff-secret');
    socket.onopen?.({});
    socket.onmessage?.({ data: FX });
    socket.onmessage?.({ data: FX });
    await Promise.resolve();
    expect(ticks).toEqual([
      expect.objectContaining({ symbol: 'BTCUSD', bid: '1.10', ask: '1.11', source: 'fastforex' }),
    ]);
    live.stop();
  });

  it('refuses to start a poll that would spend the month’s quota early', () => {
    const { live } = service({
      MARKET_LIVE_FASTFOREX: 'XAUUSD:XAUUSD',
      FASTFOREX_API_KEY: 'k',
      FASTFOREX_BASE_URL: 'https://api.fastforex.io',
      FASTFOREX_POLL_MS: 1000 as never,
      FASTFOREX_MONTHLY_QUOTA: 1_000_000 as never,
    });
    expect(live.covers('XAUUSD')).toBe(false);
  });
});

describe('the live sources’ status reports', () => {
  it('reports each change of state at once, and traffic at most every two seconds', async () => {
    const { live, sockets } = service({ MARKET_LIVE_BINANCE: 'BTCUSD:btcusdt' });
    const reports: Array<Array<{ state: string; ticks: number }>> = [];
    live.onStatus = (statuses) =>
      reports.push(statuses.map((status) => ({ state: status.state, ticks: status.ticks })));
    live.start(async () => undefined);
    const socket = sockets[0]!;
    socket.onopen?.({});
    const quote = (bid: string) =>
      JSON.stringify({
        stream: 'btcusdt@bookTicker',
        data: { s: 'BTCUSDT', b: bid, a: '65000.01' },
      });
    socket.onmessage?.({ data: quote('65000.00') });
    socket.onmessage?.({ data: quote('64999.00') });
    expect(reports.map((report) => report[0]?.state)).toEqual([
      'connecting',
      'connecting',
      'connected',
    ]);
    expect(live.status.snapshot()[0]?.ticks).toBe(2);
    socket.onclose?.({});
    expect(reports.at(-1)?.[0]?.state).toBe('disconnected');
    live.stop();
  });
});
