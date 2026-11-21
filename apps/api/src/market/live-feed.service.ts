import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TickThrottle,
  parseSymbolMap,
  isFastForexMetal,
  ticksFromFastForexQuotes,
  tickFromBinanceBookTicker,
  tickFromOandaPrice,
  tickFromTwelveDataPrice,
  type SymbolMap,
  type Tick,
} from '@tp/market-core';
import type { Env } from '../config/env.schema';
import { httpLineStream } from './http-line-stream';
import { httpPoll, monthlyCalls } from './http-poll';
import { ProviderStatusBook, type ProviderStatus } from './provider-status';

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
  readonly parse: (raw: string, now: number) => Tick | readonly Tick[] | null;
  /** Opens the connection, when it is not a WebSocket to `url`. */
  readonly open?: () => LiveSocket;
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
  /** Each source's state, for the admin screen and the metrics. */
  readonly status = new ProviderStatusBook();
  /**
   * Told when the status changes — at once on a change of state, at most every
   * two seconds for traffic. Set by `MarketFeedService`, which owns Redis and
   * the metrics; a listener that throws is not this service's problem.
   */
  onStatus: ((statuses: ProviderStatus[]) => void) | null = null;
  private lastStatusAt = 0;
  /** Replaced in tests. The platform's own is Node's built-in WebSocket. */
  socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as LiveSocket;
  /** Replaced in tests. An HTTP response read line by line (OANDA's stream). */
  streamFactory: (url: string, headers: Readonly<Record<string, string>>) => LiveSocket = (
    url,
    headers,
  ) => httpLineStream(url, headers);
  /** Replaced in tests. A REST endpoint polled on an interval (fastFOREX). */
  pollFactory: (
    urls: readonly string[],
    headers: Readonly<Record<string, string>>,
    intervalMs: number,
    active?: () => boolean,
  ) => LiveSocket = (urls, headers, intervalMs, active) =>
    httpPoll(urls, headers, intervalMs, fetch, active);

  /**
   * Whether an instrument is inside its trading session now. Set by
   * `configure`; until then every instrument counts as open, so nothing is
   * skipped by default.
   */
  private isOpen: (code: string, atMs: number) => boolean = () => true;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>) {}

  /**
   * Read the configuration against the instruments the platform has. Called
   * once, before `covers` is asked: a mapped instrument that does not exist is
   * dropped here, loudly, rather than left to never tick.
   */
  configure(
    precisionOf: (code: string) => number | undefined,
    halfSpreadOf: (code: string) => string | undefined,
    isOpen: (code: string, atMs: number) => boolean = () => true,
  ): void {
    this.sources.length = 0;
    this.isOpen = isOpen;
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

    this.configureOanda(known, precisionOf);
    this.configureFastForex(known, precisionOf);
  }

  /**
   * fastFOREX: bid/ask polled from `/fx/quote` and `/metals/quote`, ten
   * instruments a call, the key in the `X-API-Key` header. A poll interval
   * that would spend the month's quota early is refused at start-up, loudly —
   * prices that stop on the 20th are worse than prices that are slower.
   */
  private configureFastForex(
    known: (map: SymbolMap, source: string) => SymbolMap,
    precisionOf: (code: string) => number | undefined,
  ): void {
    const mapped = parseSymbolMap(this.config.get('MARKET_LIVE_FASTFOREX', { infer: true }) ?? '');
    if (Object.keys(mapped).length === 0) return;
    const key = this.config.get('FASTFOREX_API_KEY', { infer: true }) ?? '';
    if (key === '') {
      this.logger.warn('fastforex: MARKET_LIVE_FASTFOREX is set but FASTFOREX_API_KEY is not');
      return;
    }
    const fastforex = known(mapped, 'fastforex');
    const venues = Object.keys(fastforex);
    if (venues.length === 0) return;
    const base = this.config.getOrThrow('FASTFOREX_BASE_URL', { infer: true }).replace(/\/$/, '');
    const batches = (list: string[]) =>
      Array.from({ length: Math.ceil(list.length / 10) }, (_, i) =>
        list.slice(i * 10, i * 10 + 10),
      );
    const urls = [
      ...batches(venues.filter((venue) => !isFastForexMetal(venue))).map(
        (batch) => `${base}/fx/quote?pairs=${batch.join(',')}`,
      ),
      ...batches(venues.filter(isFastForexMetal)).map(
        (batch) => `${base}/metals/quote?instruments=${batch.join(',')}`,
      ),
    ];
    const interval = this.config.getOrThrow('FASTFOREX_POLL_MS', { infer: true });
    const quota = this.config.getOrThrow('FASTFOREX_MONTHLY_QUOTA', { infer: true });
    const month = monthlyCalls(urls.length, interval);
    if (month > quota) {
      this.logger.error(
        `fastforex: ${urls.length} call(s) every ${interval} ms is ${month} a month, over the quota of ${quota}; not started. Raise FASTFOREX_POLL_MS.`,
      );
      return;
    }
    const seen = new Map<string, number>();
    this.sources.push({
      name: 'fastforex',
      url: base,
      symbols: fastforex,
      hello: null,
      heartbeat: null,
      parse: (raw, now) => ticksFromFastForexQuotes(raw, fastforex, precisionOf, now, seen),
      // Polled only while at least one of its instruments is in session: the
      // weekend's answers are prices `ingest` would discard, at the quota's cost.
      open: () =>
        this.pollFactory(urls, { 'X-API-Key': key }, interval, () =>
          Object.values(fastforex).some((code) => this.isOpen(code, Date.now())),
        ),
    });
    this.logger.log(
      `fastforex: ${venues.length} instrument(s), ${urls.length} call(s) every ${interval} ms (about ${month} of ${quota} a month)`,
    );
  }

  /**
   * OANDA v20: an HTTP stream of newline-separated JSON, authorised with the
   * account's token, which goes in a header and nowhere else.
   */
  private configureOanda(
    known: (map: SymbolMap, source: string) => SymbolMap,
    precisionOf: (code: string) => number | undefined,
  ): void {
    const key = this.config.get('OANDA_API_KEY', { infer: true }) ?? '';
    const account = this.config.get('OANDA_ACCOUNT_ID', { infer: true }) ?? '';
    const mapped = parseSymbolMap(this.config.get('MARKET_LIVE_OANDA', { infer: true }) ?? '');
    if (Object.keys(mapped).length === 0) return;
    if (key === '' || account === '') {
      this.logger.warn(
        'oanda: MARKET_LIVE_OANDA is set but OANDA_API_KEY or OANDA_ACCOUNT_ID is not',
      );
      return;
    }
    const oanda = known(mapped, 'oanda');
    if (Object.keys(oanda).length === 0) return;
    const host =
      this.config.get('OANDA_ENVIRONMENT', { infer: true }) === 'live'
        ? 'https://stream-fxtrade.oanda.com'
        : 'https://stream-fxpractice.oanda.com';
    const url = `${host}/v3/accounts/${encodeURIComponent(account)}/pricing/stream?instruments=${encodeURIComponent(Object.keys(oanda).join(','))}`;
    this.sources.push({
      name: 'oanda',
      url,
      symbols: oanda,
      hello: null,
      heartbeat: null,
      parse: (raw, now) => tickFromOandaPrice(raw, oanda, precisionOf, now),
      open: () => this.streamFactory(url, { Authorization: `Bearer ${key}` }),
    });
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
    this.status.clear();
    const now = Date.now();
    for (const source of this.sources) {
      this.status.register(source.name, Object.values(source.symbols), now);
    }
    this.report(true);
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

  /** Hands the status on: always on a change of state, at most every 2 s otherwise. */
  private report(changed: boolean): void {
    const now = Date.now();
    if (!changed && now - this.lastStatusAt < 2_000) return;
    this.lastStatusAt = now;
    try {
      this.onStatus?.(this.status.snapshot());
    } catch (error) {
      this.logger.warn({ err: error }, 'live feed status listener failed');
    }
  }

  private connect(source: Source): void {
    if (!this.running) return;
    this.status.connecting(source.name, Date.now());
    this.report(true);
    let socket: LiveSocket;
    try {
      socket = source.open === undefined ? this.socketFactory(source.url) : source.open();
    } catch (error) {
      this.logger.error({ err: error }, `${source.name}: could not open the live feed`);
      this.status.disconnected(source.name, Date.now(), error);
      this.report(true);
      this.reconnectLater(source);
      return;
    }
    this.sockets.set(source.name, socket);

    socket.onopen = () => {
      this.attempts.set(source.name, 0);
      this.logger.log(`${source.name}: live feed connected`);
      this.status.connected(source.name, Date.now());
      this.report(true);
      if (source.hello !== null) socket.send(source.hello);
      if (source.heartbeat !== null) this.beat(source, socket);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const received = Date.now();
      this.status.message(source.name, received);
      const parsed = source.parse(event.data, received);
      const ticks = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed as Tick];
      for (const tick of ticks) this.status.tick(source.name, tick.timestamp, received);
      this.report(false);
      for (const parsedTick of ticks) {
        const tick: Tick = { ...parsedTick, source: source.name };
        if (!this.throttle.admit(tick)) continue;
        void this.sink?.(tick).catch((error: unknown) => {
          this.logger.error({ err: error }, `${source.name}: a live tick failed to ingest`);
        });
      }
    };
    socket.onerror = (event) => {
      // The close that follows is what reconnects; this only says it happened.
      this.logger.warn(`${source.name}: live feed socket error`);
      this.status.error(source.name, event instanceof Error ? event : 'socket error');
    };
    socket.onclose = () => {
      this.sockets.delete(source.name);
      if (!this.running) return;
      this.status.disconnected(source.name, Date.now());
      this.report(true);
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
