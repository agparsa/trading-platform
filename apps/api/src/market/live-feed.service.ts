import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TickThrottle,
  parseSymbolMap,
  tickFromBinanceBookTicker,
  tickFromTwelveDataPrice,
  type SymbolMap,
  type Tick,
} from '@tp/market-core';
import type { Env } from '../config/env.schema';

/** The part of the standard WebSocket this needs — so a test can stand in for it. */
export interface LiveSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => LiveSocket;

interface Source {
  readonly name: string;
  readonly url: string;
  readonly symbols: SymbolMap;
  /** Sent once the socket opens; none when the URL itself subscribes. */
  readonly hello: string | null;
  /** Sent on a timer to keep the venue from closing an idle socket. */
  readonly heartbeat: string | null;
  readonly parse: (raw: string, now: number) => Tick | null;
}

/** A live price is at most this old; four a second per instrument. */
const MIN_TICK_INTERVAL_MS = 250;
const HEARTBEAT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Real prices, from venues that publish them.
 *
 * The simulator invents a market; this follows one. Each configured source is
 * a WebSocket the platform listens on, and every quote it sends is handed to
 * `MarketFeedService.ingest` — the same seam, gate and fan-out the simulator's
 * ticks pass through. Nothing here decides a price is good: the integrity gate
 * does, and `requireFresh` decides whether it is still fit to trade on.
 *
 * Two rules it keeps:
 *
 *  - An instrument a live source covers is **never** simulated, even while the
 *    source is down. A feed outage shows as a stale price the engine refuses
 *    to trade on, not as an invented one that looks alive — the worst thing a
 *    price feed can do is lie about being one.
 *  - A dropped socket is reconnected, with a growing pause. It is a transport
 *    fault and is logged as one; it is never a market event.
 *
 * Off unless configured. See `docs/market-data.md`.
 */
@Injectable()
export class LiveFeedService {
  private readonly logger = new Logger(LiveFeedService.name);
  private readonly sources: Source[] = [];
  private readonly sockets = new Map<string, LiveSocket>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly throttle = new TickThrottle(MIN_TICK_INTERVAL_MS);
  private sink: ((tick: Tick) => Promise<void>) | null = null;
  private running = false;
  /** Replaced in tests. The platform's own is Node's built-in WebSocket. */
  socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as LiveSocket;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>) {}

  /**
   * Read the configuration against the instruments the platform has. Called
   * once, before `covers` is asked: a mapped instrument that does not exist is
   * dropped here, loudly, rather than left to never tick.
   */
  configure(
    precisionOf: (code: string) => number | undefined,
    halfSpreadOf: (code: string) => string | undefined,
  ): void {
    this.sources.length = 0;
    const known = (map: SymbolMap, source: string): SymbolMap => {
      const kept: Record<string, string> = {};
      for (const [venue, code] of Object.entries(map)) {
        if (precisionOf(code) === undefined) {
          this.logger.warn(`${source}: ${code} is not an instrument here; ignoring ${venue}`);
        } else if (this.covers(code)) {
          this.logger.warn(`${source}: ${code} already has a live source; ignoring ${venue}`);
        } else {
          kept[venue] = code;
        }
      }
      return kept;
    };

    const binance = known(
      parseSymbolMap(this.config.get('MARKET_LIVE_BINANCE', { infer: true }) ?? ''),
      'binance',
    );
    if (Object.keys(binance).length > 0) {
      const streams = Object.keys(binance)
        .map((symbol) => `${symbol.toLowerCase()}@bookTicker`)
        .join('/');
      this.sources.push({
        name: 'binance',
        url: `${this.config.getOrThrow('MARKET_LIVE_BINANCE_URL', { infer: true })}/stream?streams=${streams}`,
        symbols: binance,
        hello: null,
        heartbeat: null,
        parse: (raw, now) => tickFromBinanceBookTicker(raw, binance, precisionOf, now),
      });
    }

    const key = this.config.get('TWELVEDATA_API_KEY', { infer: true }) ?? '';
    const mapped = parseSymbolMap(this.config.get('MARKET_LIVE_TWELVEDATA', { infer: true }) ?? '');
    if (key !== '' && Object.keys(mapped).length > 0) {
      const twelve = known(mapped, 'twelvedata');
      if (Object.keys(twelve).length > 0) {
        this.sources.push({
          name: 'twelvedata',
          // The key travels in the URL because that is the documented way;
          // the URL is never logged — `describe()` is what is.
          url: `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(key)}`,
          symbols: twelve,
          hello: JSON.stringify({
            action: 'subscribe',
            params: { symbols: Object.keys(twelve).join(',') },
          }),
          heartbeat: JSON.stringify({ action: 'heartbeat' }),
          parse: (raw, now) => tickFromTwelveDataPrice(raw, twelve, precisionOf, halfSpreadOf, now),
        });
      }
    }
  }

  /** Whether a live source, up or down, is this instrument's price. */
  covers(code: string): boolean {
    return this.sources.some((source) => Object.values(source.symbols).includes(code));
  }

  /** What is followed and from where, for the start-up log. No URL, no key. */
  describe(): string {
    return this.sources.length === 0
      ? 'none'
      : this.sources
          .map((source) => `${source.name} (${Object.values(source.symbols).join(', ')})`)
          .join('; ');
  }

  start(sink: (tick: Tick) => Promise<void>): void {
    if (this.running) return;
    this.running = true;
    this.sink = sink;
    for (const source of this.sources) this.connect(source);
  }

  stop(): void {
    this.running = false;
    this.sink = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets.values()) {
      socket.onclose = null;
      socket.close();
    }
    this.sockets.clear();
  }

  private connect(source: Source): void {
    if (!this.running) return;
    let socket: LiveSocket;
    try {
      socket = this.socketFactory(source.url);
    } catch (error) {
      this.logger.error({ err: error }, `${source.name}: could not open the live feed`);
      this.reconnectLater(source);
      return;
    }
    this.sockets.set(source.name, socket);

    socket.onopen = () => {
      this.attempts.set(source.name, 0);
      this.logger.log(`${source.name}: live feed connected`);
      if (source.hello !== null) socket.send(source.hello);
      if (source.heartbeat !== null) this.beat(source, socket);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const tick = source.parse(event.data, Date.now());
      if (tick === null || !this.throttle.admit(tick)) return;
      void this.sink?.(tick).catch((error: unknown) => {
        this.logger.error({ err: error }, `${source.name}: a live tick failed to ingest`);
      });
    };
    socket.onerror = () => {
      // The close that follows is what reconnects; this only says it happened.
      this.logger.warn(`${source.name}: live feed socket error`);
    };
    socket.onclose = () => {
      this.sockets.delete(source.name);
      if (!this.running) return;
      this.logger.warn(
        `${source.name}: live feed disconnected; its instruments hold their last price until it returns`,
      );
      this.reconnectLater(source);
    };
  }

  private reconnectLater(source: Source): void {
    const attempt = (this.attempts.get(source.name) ?? 0) + 1;
    this.attempts.set(source.name, attempt);
    const pause = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 5));
    this.timers.set(
      `reconnect:${source.name}`,
      setTimeout(() => this.connect(source), pause),
    );
  }

  /** A self-rescheduling timeout, as the feed's own pump is. */
  private beat(source: Source, socket: LiveSocket): void {
    this.timers.set(
      `beat:${source.name}`,
      setTimeout(() => {
        if (!this.running || this.sockets.get(source.name) !== socket) return;
        try {
          socket.send(source.heartbeat ?? '');
        } catch {
          // A socket that cannot be written to is about to close and reconnect.
        }
        this.beat(source, socket);
      }, HEARTBEAT_MS),
    );
  }
}
