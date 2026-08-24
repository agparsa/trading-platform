import { beforeEach, describe, expect, it } from 'vitest';
import { WsChannel } from '@tp/shared-types';
import type { Candle, Tick } from '@tp/market-core';
import { RealtimeGateway } from './realtime.gateway';
import { initialState, type TradingSocket } from './socket.types';
import { CandleBus } from '../market/candle-bus';
import { TickBus } from '../market/tick-bus';

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

function fakeSocket(): TradingSocket & { frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    state: initialState(),
    frames,
    emit: (event: string, payload: unknown) => {
      if (event === 'frame') frames.push(payload as Frame);
      return true;
    },
  } as unknown as TradingSocket & { frames: Frame[] };
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

/**
 * Only the collaborators these paths actually touch are real. Anything the
 * candle and quote filters never reach is a stub, so a failure here can only
 * mean the filter is wrong.
 */
function buildGateway() {
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

  const gateway = new RealtimeGateway(
    {} as never,
    {} as never,
    quotes as never,
    ticks,
    candles,
    events as never,
    redis as never,
    metrics as never,
  );
  return { gateway, ticks, candles };
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
    harness.gateway.handleSubscribe(socket, {
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
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.CANDLES, symbols: ['XAUUSD'] });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: true });

    expect(socket.frames[0]?.data['closed']).toBe(true);
  });

  it('defaults a candle subscription with no resolution to one minute', async () => {
    const socket = fakeSocket();
    attach(socket);
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.CANDLES, symbols: ['XAUUSD'] });

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
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });
    harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
      resolutions: ['1'],
    });

    await harness.ticks.publish(tick('EURUSD'));
    await harness.ticks.publish(tick('BTCUSD'));

    const quotes = socket.frames.filter((frame) => frame.event === 'quote.update');
    expect(quotes.map((frame) => frame.data['symbol'])).toEqual(['EURUSD', 'BTCUSD']);
  });

  /**
   * Switching instrument must stop the old stream. Accumulating would leave a
   * trader who has changed chart four times paying for four streams they cannot
   * see.
   */
  it('replaces the chart subscription rather than accumulating it', async () => {
    const socket = fakeSocket();
    attach(socket);
    harness.gateway.handleSubscribe(socket, {
      channel: WsChannel.CANDLES,
      symbols: ['XAUUSD'],
      resolutions: ['1'],
    });
    harness.gateway.handleSubscribe(socket, {
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
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.CANDLES, symbols: ['XAUUSD'] });
    harness.gateway.handleUnsubscribe(socket, { channel: WsChannel.CANDLES });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });

    expect(socket.frames).toHaveLength(0);
  });

  it('sends nothing to a socket that never subscribed to candles', async () => {
    const socket = fakeSocket();
    attach(socket);
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });

    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });

    expect(socket.frames).toHaveLength(0);
  });

  it('numbers every frame on a connection consecutively', async () => {
    const socket = fakeSocket();
    attach(socket);
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.QUOTES });
    harness.gateway.handleSubscribe(socket, { channel: WsChannel.CANDLES, symbols: ['XAUUSD'] });

    await harness.ticks.publish(tick('XAUUSD'));
    await harness.candles.publish({ candle: candle('XAUUSD', '1'), closed: false });
    await harness.ticks.publish(tick('XAUUSD'));

    expect(socket.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });
});
