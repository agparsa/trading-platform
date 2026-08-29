import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CandleAggregator,
  InternalMarketSimulator,
  isResolution,
  type Candle,
  type MarketDataProvider,
  type Resolution,
  type SimulatedInstrument,
  systemClock,
  type Tick,
} from '@tp/market-core';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';
import { SymbolsService } from '../symbols/symbols.service';
import { MarketIntegrityService } from './market-integrity.service';
import { QuoteService } from './quote.service';
import { TickBus } from './tick-bus';
import { CandleBus } from './candle-bus';
import { isSessionOpen } from './session';
import type { Env } from '../config/env.schema';

/** Redis channel every API instance relays to its own WebSocket clients. */
export const TICK_CHANNEL = 'market:ticks';

/**
 * Owns the market feed.
 *
 * Responsibilities, in order: pull ticks from the configured provider, publish
 * them as the current quote, aggregate them into candles, and persist a candle
 * when it closes.
 *
 * Exactly one process must run this. Two ingesters would double-count candle
 * volume, which is why it is gated behind `MARKET_INGEST_ENABLED` rather than
 * simply running wherever the module is loaded.
 */
@Injectable()
export class MarketFeedService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MarketFeedService.name);
  private provider: MarketDataProvider | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly aggregators = new Map<string, CandleAggregator>();
  private resolutions: Resolution[] = [];
  private relaying = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
    private readonly integrity: MarketIntegrityService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly ticks: TickBus,
    private readonly candles: CandleBus,
  ) {}

  /**
   * Started from `onApplicationBootstrap`, not `onModuleInit`.
   *
   * The feed needs every instrument definition loaded before it can build the
   * simulator. `onModuleInit` runs per provider while others are still
   * initialising; `onApplicationBootstrap` runs once everything is ready.
   */
  async onApplicationBootstrap(): Promise<void> {
    this.resolutions = this.config
      .getOrThrow('CANDLE_RESOLUTIONS', { infer: true })
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is Resolution => isResolution(value));

    if (!this.config.getOrThrow('MARKET_INGEST_ENABLED', { infer: true })) {
      /**
       * This instance does not ingest — but it still has to *know the price*.
       *
       * Exactly one process may pull from the provider, or candle volume is
       * counted twice. Every other process still runs valuations, serves
       * `GET /market/quotes` and pushes account frames to its own sockets, and
       * without prices it would do all three against whatever it last read out
       * of Redis. So it relays: the ingesting instance publishes each tick on
       * `market:ticks`, and this listens.
       *
       * The channel was being published to and nothing was listening. That was
       * survivable only because nothing had been scaled past one instance yet;
       * the moment it was, half the traders would have watched a dead terminal.
       */
      await this.startRelay();
      return;
    }

    const kind = this.config.getOrThrow('MARKET_DATA_PROVIDER', { infer: true });
    if (kind !== 'internal-simulator') {
      // Refusing to start beats starting with no prices and discovering it when
      // the first order is rejected.
      throw new Error(
        `MARKET_DATA_PROVIDER='${kind}' has no adapter yet. Implement MarketDataProvider and register it here.`,
      );
    }

    this.provider = this.buildSimulator();
    await this.provider.start();
    this.running = true;
    this.scheduleNextPump();
    this.logger.log(
      `Market feed started: ${this.provider.name}, ${this.symbols.codes().length} instrument(s), resolutions ${this.resolutions.join(',')}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.relaying) {
      this.relaying = false;
      await this.redis.subscriber.unsubscribe(TICK_CHANNEL);
    }
    await this.provider?.stop();
    // Persist the partial candles rather than discarding a minute of data.
    // A relaying instance has aggregators too, and none of them are its to save.
    if (this.provider === null) return;
    for (const aggregator of this.aggregators.values()) {
      const candle = aggregator.flush();
      if (candle !== null) await this.persistCandle(candle);
    }
  }

  /**
   * The tick loop.
   *
   * A self-rescheduling `setTimeout`, not `setInterval`. `setInterval` queues
   * callbacks behind a slow iteration and then fires them back to back, so a
   * momentary database stall would be followed by a burst of ticks with
   * near-identical timestamps. Rescheduling after the work completes cannot do
   * that, and the next delay is corrected for how long this pass actually took.
   */
  private scheduleNextPump(): void {
    if (!this.running) return;
    const interval = this.config.getOrThrow('MARKET_SIMULATOR_TICK_MS', { infer: true });
    const startedAt = Date.now();

    this.timer = setTimeout(() => {
      void this.pump()
        .catch((error: unknown) => {
          // A failed pass must not kill the loop; the market keeps moving.
          this.logger.error({ err: error }, 'Market feed pass failed');
        })
        .finally(() => {
          const elapsed = Date.now() - startedAt - interval;
          this.timer = null;
          if (this.running) {
            setTimeout(() => this.scheduleNextPump(), Math.max(0, interval - Math.max(0, elapsed)));
          }
        });
    }, interval);
  }

  private async pump(): Promise<void> {
    const simulator = this.provider as InternalMarketSimulator | null;
    if (simulator === null) return;
    const ticks = simulator.pump();
    for (const tick of ticks) await this.ingest(tick);
  }

  /**
   * Listen for ticks another instance ingested.
   *
   * They go through the same gate and the same fan-out as locally generated
   * ones — a relayed tick is still market data from outside this process, and a
   * crossed book does not become trustworthy by crossing Redis first. What it
   * does *not* do is re-publish to `market:ticks` (that would echo forever) or
   * persist candles (the ingesting instance owns those rows; two writers would
   * be two upserts racing for the same bucket).
   */
  private async startRelay(): Promise<void> {
    this.relaying = true;
    this.redis.subscriber.on('message', (channel: string, payload: string) => {
      if (channel !== TICK_CHANNEL || !this.relaying) return;
      let tick: Tick;
      try {
        tick = JSON.parse(payload) as Tick;
      } catch {
        // Malformed payloads are a transport fault, not a market event. The
        // gate would refuse it anyway; parsing failure just refuses it sooner.
        return;
      }
      void this.ingest(tick, { relayed: true }).catch((error: unknown) => {
        this.logger.error({ err: error }, 'Relayed tick failed');
      });
    });
    await this.redis.subscriber.subscribe(TICK_CHANNEL);
    this.logger.log(
      'Market ingestion is disabled on this instance; relaying ticks from market:ticks instead',
    );
  }

  /**
   * Take one tick from outside and make it the platform's price.
   *
   * Public and named, because it is the seam every market data source arrives
   * through: the built-in simulator's pump, the relay on a non-ingesting
   * instance, and — when one exists — an external provider adapter pushing over
   * a webhook or a socket. `MarketDataProvider` describes how to *pull*; this is
   * what a provider that pushes calls, and having it be a private method reached
   * only from the pump loop was the reason there was no way to write one.
   *
   * Returns nothing. A tick that is refused, out of session, or older than the
   * price already held simply does not become a price; a caller must not read
   * silence as a market event, and must not read acceptance as a fill.
   */
  async ingest(tick: Tick, options: { relayed?: boolean } = {}): Promise<void> {
    const instrument = this.symbols.find(tick.symbol);
    // Outside its session an instrument produces no tradeable price. Publishing
    // one would let a stop fire on a weekend.
    if (instrument === undefined || !isSessionOpen(instrument.session, tick.timestamp)) return;

    /**
     * The integrity gate, before anything else sees the tick.
     *
     * Placed here rather than inside `QuoteService` deliberately: a rejected
     * tick must reach neither the quote, nor the trigger engine, nor the candle
     * aggregator, nor the socket. A crossed book that was refused as a quote but
     * still evaluated stops would be the worst of both — the price nobody
     * believes, deciding whether a position closes.
     *
     * A rejection is a statement about the feed and never about the market. The
     * previous price stands, and `requireFresh` is what decides whether it is
     * still fit to trade on.
     */
    if (!this.integrity.admit(tick).accepted) return;

    // A tick older than the one already held loses to it — see QuoteService.
    if (!(await this.quotes.publish(tick))) return;
    this.metrics.marketTicks.inc({ symbol: tick.symbol });
    if (options.relayed !== true) {
      await this.redis.publisher.publish(TICK_CHANNEL, JSON.stringify(tick));
    }

    // Local consumers (trigger engine, WebSocket gateway) run before the next
    // tick is generated, so a stop is evaluated against every price the market
    // actually printed rather than against a sample of them.
    await this.ticks.publish(tick);

    // Snapshotting the in-progress bars costs something, so it is skipped
    // entirely when no chart is listening.
    const broadcast = this.candles.subscriberCount > 0;

    for (const resolution of this.resolutions) {
      const key = `${tick.symbol}:${resolution}`;
      let aggregator = this.aggregators.get(key);
      if (aggregator === undefined) {
        aggregator = new CandleAggregator(tick.symbol, resolution);
        this.aggregators.set(key, aggregator);
      }
      const closed = aggregator.push(tick);
      // Only the ingesting instance writes candle rows. A relayed pass keeps
      // its own aggregator so its charts have a live bar, and writes nothing.
      if (closed !== null && options.relayed !== true) await this.persistCandle(closed);
      if (!broadcast) continue;

      // A closed bucket produces two frames: the final state of the bar that
      // ended, then the bar that opened. Sending only the new one would leave
      // the chart's last completed candle showing a mid-bucket close forever.
      if (closed !== null) await this.candles.publish({ candle: closed, closed: true });
      const open = aggregator.peek();
      if (open !== null) await this.candles.publish({ candle: open, closed: false });
    }
  }

  /**
   * Upsert rather than insert: a restart mid-bucket re-opens the same candle,
   * and the second write must correct the first, not collide with it.
   */
  private async persistCandle(candle: Candle): Promise<void> {
    const time = new Date(candle.time);
    await this.prisma.candle.upsert({
      where: {
        symbolCode_resolution_time: {
          symbolCode: candle.symbol,
          resolution: candle.resolution,
          time,
        },
      },
      create: {
        symbolCode: candle.symbol,
        resolution: candle.resolution,
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
      update: {
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
    });
  }

  /** In-progress candle for a symbol, so a chart's last bar is not a minute stale. */
  currentCandle(symbol: string, resolution: Resolution): Candle | null {
    return this.aggregators.get(`${symbol}:${resolution}`)?.peek() ?? null;
  }

  private buildSimulator(): InternalMarketSimulator {
    const seed = this.config.getOrThrow('MARKET_SIMULATOR_SEED', { infer: true });
    const tickIntervalMs = this.config.getOrThrow('MARKET_SIMULATOR_TICK_MS', { infer: true });

    const instruments: SimulatedInstrument[] = this.symbols.list().map((definition) => ({
      definition,
      startPrice: SIMULATOR_START_PRICES[definition.spec.code] ?? '100',
      volatility: SIMULATOR_VOLATILITY[definition.spec.code] ?? 0.0002,
      // Half the typical spread seen on the reference terminal for this class
      // of instrument, expressed in price units.
      baseHalfSpread: SIMULATOR_HALF_SPREAD[definition.spec.code] ?? '0.05',
      tickIntervalMs,
    }));

    return new InternalMarketSimulator({
      instruments,
      seed,
      clock: systemClock,
      resolutions: this.resolutions,
    });
  }
}

/**
 * Starting points for the simulated walk.
 *
 * These are plausible levels for each instrument, not live prices, and the
 * simulator is not a price forecast. They exist so a developer's local market
 * looks like the real one at a glance.
 */
const SIMULATOR_START_PRICES: Readonly<Record<string, string>> = {
  XAUUSD: '4583.65',
  XAGUSD: '69.610',
  BTCUSD: '77650.00',
  ETHUSD: '2985.40',
  EURUSD: '1.08750',
  AUDUSD: '0.71580',
  GBPUSD: '1.27340',
  USDJPY: '155.250',
};

const SIMULATOR_VOLATILITY: Readonly<Record<string, number>> = {
  XAUUSD: 0.0002,
  XAGUSD: 0.0004,
  BTCUSD: 0.0006,
  ETHUSD: 0.0009,
  EURUSD: 0.00008,
  AUDUSD: 0.0001,
  GBPUSD: 0.00009,
  USDJPY: 0.00007,
};

const SIMULATOR_HALF_SPREAD: Readonly<Record<string, string>> = {
  XAUUSD: '0.07',
  XAGUSD: '0.0125',
  BTCUSD: '2.50',
  ETHUSD: '0.35',
  EURUSD: '0.00005',
  AUDUSD: '0.000005',
  GBPUSD: '0.00006',
  USDJPY: '0.005',
};
