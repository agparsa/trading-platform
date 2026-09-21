import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { WsChannel } from '@tp/shared-types';
import type { Candle, Tick } from '@tp/market-core';
import { BUILD_HEADER, RealtimeGateway } from './realtime.gateway';
import { buildMarker } from '../health/health.controller';
import { initialState, type TradingSocket } from './socket.types';
import { CandleBus } from '../market/candle-bus';
import { TickBus } from '../market/tick-bus';

/** The tenant every socket in this file authenticates into. */
const TENANT_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Subscription routing.
 *
 * These are the filters that decide what a connected browser receives. They are
 * tested against a hand-built gateway rather than a live socket because the
 * question here is not "does the transport work" — `scripts/smoke-ws.ts` answers
 * that against a running server — but "does a subscription mean what it says".
 */

interface Frame {
  event: string;
  data: Record<string, unknown>;
  seq: number;
}

interface Emitted {
  event: string;
  payload: unknown;
}

function fakeSocket(): TradingSocket & { frames: Frame[]; emitted: Emitted[] } {
  const frames: Frame[] = [];
  const emitted: Emitted[] = [];
  return {
    state: initialState(),
    frames,
    emitted,
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      if (event === 'frame') frames.push(payload as Frame);
      return true;
    },
  } as unknown as TradingSocket & { frames: Frame[]; emitted: Emitted[] };
}

const candle = (symbol: string, resolution: string, close = '2000'): Candle => ({
  symbol,
  resolution: resolution as Candle['resolution'],
  time: 1_700_000_000_000,
  open: '1999',
  high: '2001',
  low: '1998',
  close,
  volume: '12',
});

const tick = (symbol: string): Tick => ({
  symbol,
  bid: '2000.00',
  ask: '2000.20',
  timestamp: 1_700_000_000_000,
  volume: '1',
});

const symbolsIn = (frame: { data: unknown }): string[] =>
  (frame.data as Array<{ symbol: string }>).map((quote) => quote.symbol);

/**
 * Only the collaborators these paths actually touch are real. Anything the
 * candle and quote filters never reach is a stub, so a failure here can only
 * mean the filter is wrong.
 */
function buildGateway(
  accounts: { owned?: string[]; linked?: string[] } = { owned: [], linked: [] },
  /** `0` relays every tick as it arrives, so the filter tests read frames synchronously. */
  quoteFanoutIntervalMs = 0,
) {
  const ticks = new TickBus();
  const candles = new CandleBus();
  const quotes = {
    toDto: (t: Tick) => ({ symbol: t.symbol, bid: t.bid, ask: t.ask, spread: '0.20' }),
  };
  const redis = {
    subscriber: { subscribe: async () => 1, on: () => undefined, unsubscribe: async () => 1 },
  };
  const events = { onEvent: () => () => undefined };
  const metrics = { websocketConnections: { inc: () => undefined } };

  const prisma = {
    account: {
      findMany: async () => (accounts.owned ?? []).map((id) => ({ id })),
    },
    masterAccountLink: {
      findMany: async () => (accounts.linked ?? []).map((accountId) => ({ accountId })),
    },
  };

  const gateway = new RealtimeGateway(
    {} as never,
    prisma as never,
    quotes as never,
    ticks,
    candles,
    events as never,
    redis as never,
    metrics as never,
    { forHost: async () => ({ tenantId: TENANT_ID, slug: 'test' }) } as never,
    { get: () => quoteFanoutIntervalMs } as never,
  );
  /**
   * Nest assigns `server` before `afterInit` runs; here it is assigned by hand.
   * Only the Engine.IO event emitter is real, because the handshake-header test
   * drives it and everything else about the server is never reached.
   */
  const engine = new EventEmitter();
  Object.assign(gateway, { server: { engine } });
  return { gateway, ticks, candles, engine };
}

describe('RealtimeGateway subscriptions', () => {
  let harness: ReturnType<typeof buildGateway>;

  beforeEach(async () => {
    harness = buildGateway();
    await harness.gateway.afterInit();
  });

  /** Sockets are registered by `handleConnection`; these tests inject directly. */
  function attach(socket: TradingSocket): void {
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);
  }

  it('sends candles only for the subscribed symbol and resolution', async () => {
    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    attach(socket);
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
      resolutions: ['1'],
    });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });
    await harness.candles.publish({ candle: candle('XAUUSD', '15'), closed: false });
    await harness.candles.publish({ candle: candle('EURUSD', '1'), closed: false });

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]?.data).toMatchObject({ symbol: 'XAUUSD', resolution: '1' });
  });

  it('marks a closed bucket so a chart can finalise the bar', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
    });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: true });

    expect(socket.frames[0]?.data['closed']).toBe(true);
  });

  it('defaults a candle subscription with no resolution to one minute', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
    });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });
    await harness.candles.publish({ candle: candle('XAUUSD', '60'), closed: false });

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]?.data['resolution']).toBe('1');
  });

  /**
   * The bug this pins: quotes and candles used to share one symbol set, so
   * charting a single instrument silently narrowed the watchlist to it. A trader
   * would have watched four rows stop updating with nothing on screen to explain
   * why.
   */
  it('does not narrow the quote stream when a chart subscribes to one symbol', async () => {
    const socket = fakeSocket();
    attach(socket);
    // Every symbol, as the watchlist asks for.
    await harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
      resolutions: ['1'],
    });

    await harness.ticks.publish(tick('EURUSD'));
    await harness.ticks.publish(tick('BTCUSD'));

    const quotes = socket.frames.filter((frame) => frame.event === 'quotes.updated');
    expect(quotes.flatMap((frame) => symbolsIn(frame))).toEqual(['EURUSD', 'BTCUSD']);
  });

  /**
   * Conflation. Two hundred sockets receiving a frame per tick was twenty
   * thousand serialisations a second for eight instruments, and at a thousand
   * sockets the event loop stalled long enough to lose the leadership lease.
   * With an interval, a socket gets one frame per interval carrying the newest
   * quote of each symbol that moved — and only the newest.
   */
  describe('with a fan-out interval', () => {
    it('sends one frame per interval carrying the newest quote of every symbol that moved', async () => {
      const conflating = buildGateway({ owned: [], linked: [] }, 20);
      await conflating.gateway.afterInit();
      const socket = fakeSocket();
      conflating.gateway['sockets'].add(socket);
      await conflating.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });

      await conflating.ticks.publish({ ...tick('XAUUSD'), bid: '2000.00' });
      await conflating.ticks.publish({ ...tick('XAUUSD'), bid: '2001.00' });
      await conflating.ticks.publish({ ...tick('XAUUSD'), bid: '2002.00' });
      await conflating.ticks.publish(tick('EURUSD'));
      expect(socket.frames).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(socket.frames).toHaveLength(1);
      const quotes = socket.frames[0]!.data as unknown as Array<{ symbol: string; bid: string }>;
      expect(quotes).toHaveLength(2);
      expect(quotes.find((q) => q.symbol === 'XAUUSD')?.bid).toBe('2002.00');
      expect(quotes.some((q) => q.symbol === 'EURUSD')).toBe(true);
      await conflating.gateway.onApplicationShutdown();
    });

    it('filters the batch to the symbols a socket asked for, and sends nothing when none of them moved', async () => {
      const conflating = buildGateway({ owned: [], linked: [] }, 20);
      await conflating.gateway.afterInit();
      const watching = fakeSocket();
      const elsewhere = fakeSocket();
      conflating.gateway['sockets'].add(watching);
      conflating.gateway['sockets'].add(elsewhere);
      await conflating.gateway.handleSubscribe(watching, {
        channel: WsChannel.QUOTES,
        symbols: ['XAUUSD'],
      });
      await conflating.gateway.handleSubscribe(elsewhere, {
        channel: WsChannel.QUOTES,
        symbols: ['BTCUSD'],
      });

      await conflating.ticks.publish(tick('XAUUSD'));
      await conflating.ticks.publish(tick('EURUSD'));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(watching.frames).toHaveLength(1);
      expect(symbolsIn(watching.frames[0]!)).toEqual(['XAUUSD']);
      expect(elsewhere.frames).toHaveLength(0);
      await conflating.gateway.onApplicationShutdown();
    });

    it('sends nothing while the market is still', async () => {
      const conflating = buildGateway({ owned: [], linked: [] }, 20);
      await conflating.gateway.afterInit();
      const socket = fakeSocket();
      conflating.gateway['sockets'].add(socket);
      await conflating.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(socket.frames).toHaveLength(0);
      await conflating.gateway.onApplicationShutdown();
    });
  });

  /**
   * Switching instrument must stop the old stream. Accumulating would leave a
   * trader who has changed chart four times paying for four streams they cannot
   * see.
   */
  it('replaces the chart subscription rather than accumulating it', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
      resolutions: ['1'],
    });
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['EURUSD'],
      resolutions: ['15'],
    });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });
    await harness.candles.publish({ candle: candle('EURUSD', '15'), closed: false });

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]?.data).toMatchObject({ symbol: 'EURUSD', resolution: '15' });
  });

  it('stops candle frames after an unsubscribe', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
    });
    harness.gateway.handleUnsubscribe(socket, { channel: WsChannel.CANDLES });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });

    expect(socket.frames).toHaveLength(0);
  });

  it('sends nothing to a socket that never subscribed to candles', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });

    expect(socket.frames).toHaveLength(0);
  });

  it('numbers every frame on a connection consecutively', async () => {
    const socket = fakeSocket();
    attach(socket);
    await harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });
    await harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
    });

    await harness.ticks.publish(tick('XAUUSD'));
    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });
    await harness.ticks.publish(tick('XAUUSD'));

    expect(socket.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });
});

/**
 * Authority a socket acquired once and then kept.
 *
 * A WebSocket outlives the token that opened it, and its account set used to be
 * resolved at connect and never again. Both are about the same mistake: a
 * connection is a *long-lived* thing, and permissions are not.
 */
describe('RealtimeGateway authority refresh', () => {
  it('drops a socket whose access token has expired, and keeps it connected', async () => {
    const harness = buildGateway({ owned: ['account-1'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    socket.state.accountIds.add('account-1');
    socket.state.tokenExpiresAt = 1_000;
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);

    expect(socket.state.userId).toBeNull();
    expect(socket.state.accountIds.size).toBe(0);
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(true);
    // Downgraded, not closed: a closed socket reconnects with the same dead
    // token and the pair of them spin.
    expect(
      (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.has(socket),
    ).toBe(true);
  });

  it('leaves a socket alone while its token is still good', async () => {
    const harness = buildGateway({ owned: ['account-1'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    socket.state.tenantId = TENANT_ID;
    socket.state.tenantSlug = 'test';
    socket.state.accountIds.add('account-1');
    socket.state.tokenExpiresAt = 10_000;
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);

    expect(socket.state.userId).toBe('user-1');
    expect([...socket.state.accountIds]).toEqual(['account-1']);
  });

  /**
   * The one that matters. A master-account link revoked this morning used to go
   * on delivering somebody else's positions until the operator happened to
   * reconnect.
   */
  it('stops honouring an account the user may no longer see', async () => {
    const harness = buildGateway({ owned: ['account-1'], linked: [] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    socket.state.tenantId = TENANT_ID;
    socket.state.tenantSlug = 'test';
    socket.state.accountIds.add('account-1');
    socket.state.accountIds.add('revoked-link');
    socket.state.tokenExpiresAt = 10_000;
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);

    expect([...socket.state.accountIds]).toEqual(['account-1']);
  });

  it('picks up an account opened after the socket connected', async () => {
    const harness = buildGateway({ owned: ['account-1', 'account-2'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    socket.state.tenantId = TENANT_ID;
    socket.state.tenantSlug = 'test';
    socket.state.accountIds.add('account-1');
    socket.state.tokenExpiresAt = 10_000;
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);

    expect([...socket.state.accountIds].sort()).toEqual(['account-1', 'account-2']);
  });

  /**
   * A socket that is authenticated but carries no tenant cannot exist — the two
   * are set together at connection. If one ever did, its authority could not be
   * re-checked, and authority that cannot be checked is not kept.
   */
  it('drops an authenticated socket that somehow has no tenant', async () => {
    const harness = buildGateway({ owned: ['account-1'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    socket.state.accountIds.add('account-1');
    socket.state.tokenExpiresAt = 10_000;
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);

    expect(socket.state.userId).toBeNull();
    expect([...socket.state.accountIds]).toEqual([]);
    // Downgraded, not disconnected: the socket may still take public data.
    expect(
      (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.has(socket),
    ).toBe(true);
  });

  it('does nothing to an unauthenticated socket', async () => {
    const harness = buildGateway();
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    await harness.gateway.refreshSockets(2_000);
    expect(socket.emitted).toEqual([]);
  });
});

/**
 * The socket had no rate limit at all, so `subscribe` in a loop was an unmetered
 * way to make this process parse and validate as fast as a client could write.
 */
describe('RealtimeGateway message budget', () => {
  it('refuses once a socket has spent its budget, and says so once', async () => {
    const harness = buildGateway({ owned: ['account-1'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    let refusals = 0;
    for (let i = 0; i < 400; i += 1) {
      const answer = await harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });
      if (!answer.ok) refusals += 1;
    }

    expect(refusals).toBeGreaterThan(0);
    const told = socket.emitted.filter(
      (e) => e.event === 'error' && (e.payload as { code?: string }).code === 'RATE_LIMITED',
    );
    // Told once, not on every refusal: answering a client in a loop as fast as
    // it asks is the traffic the limit exists to stop.
    expect(told).toHaveLength(1);
  });

  it('lets an ordinary terminal through untouched', async () => {
    const harness = buildGateway({ owned: ['account-1'] });
    await harness.gateway.afterInit();

    const socket = fakeSocket();
    socket.state.userId = 'user-1';
    (harness.gateway as unknown as { sockets: Set<TradingSocket> }).sockets.add(socket);

    // Five channels on connect, then a chart change. Nowhere near the limit.
    for (const channel of [
      WsChannel.QUOTES,
      WsChannel.ORDERS,
      WsChannel.POSITIONS,
      WsChannel.ACCOUNT,
      WsChannel.PNL,
    ]) {
      expect((await harness.gateway.handleSubscribe(socket, { channel })).ok).toBe(true);
    }
    expect(
      (
        await harness.gateway.handleSubscribe(socket, {
          channel: WsChannel.CANDLES,
          symbols: ['XAUUSD'],
        })
      ).ok,
    ).toBe(true);
    expect(socket.emitted.filter((e) => e.event === 'error')).toEqual([]);
  });
});

describe('RealtimeGateway handshake', () => {
  /**
   * The real-time service is its own container on the API image, and on
   * 21 September it was sixteen commits behind the API while every check was
   * green: nothing outside the host could ask it which build it ran. Now the
   * Engine.IO handshake carries the same marker `/health` publishes, and
   * `verify:production` compares it to the deployed commit.
   */
  it('names the running build in a header on the handshake response', async () => {
    const harness = buildGateway();
    await harness.gateway.afterInit();

    const headers: Record<string, string> = {};
    harness.engine.emit('initial_headers', headers, {});

    expect(headers[BUILD_HEADER]).toBe(buildMarker());
    // The digest, not the commit: the same value `/health` reports, so the
    // two can be compared without either side knowing the hash.
    expect(headers[BUILD_HEADER]).toMatch(/^([0-9a-f]{12}|unknown)$/);
    await harness.gateway.onApplicationShutdown();
  });

  it('is the digest of BUILD_SHA when one was stamped', async () => {
    const before = process.env['BUILD_SHA'];
    process.env['BUILD_SHA'] = 'f05ed1c18740f02f8bec7708b89407448fbe5b7b';
    try {
      const harness = buildGateway();
      await harness.gateway.afterInit();
      const headers: Record<string, string> = {};
      harness.engine.emit('initial_headers', headers, {});
      expect(headers[BUILD_HEADER]).toBe(buildMarker('f05ed1c18740f02f8bec7708b89407448fbe5b7b'));
      expect(headers[BUILD_HEADER]).not.toBe('unknown');
      await harness.gateway.onApplicationShutdown();
    } finally {
      if (before === undefined) delete process.env['BUILD_SHA'];
      else process.env['BUILD_SHA'] = before;
    }
  });
});
