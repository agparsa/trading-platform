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
import { LeadershipService, LeaderLoop } from '../leadership/leadership.service';
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
  /**
   * Registered once, whatever happens afterwards. The relay is switched on and
   * off many times over a process's life — every time leadership changes hands
   * — and re-adding the listener each time would stack duplicates on the Redis
   * client until one tick arrived N times.
   */
  private relayListenerBound = false;

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
    private readonly leadership: LeadershipService,
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

    /**
     * Every instance relays to begin with — including the one that will end up
     * ingesting.
     *
     * An instance that does not pull from the provider still has to *know the
     * price*: it runs valuations, serves `GET /market/quotes` and pushes
     * account frames to its own sockets, and without prices it would do all
     * three against whatever it last read out of Redis. So the ingesting
     * instance publishes each tick on `market:ticks` and everyone else listens.
     *
     * Starting here rather than after losing an election matters during a
     * deploy: a new container that comes up while the old one still holds the
     * lease serves correct prices from its first second instead of serving
     * stale ones until it wins.
     */
    await this.startRelay();

    if (!this.config.getOrThrow('MARKET_INGEST_ENABLED', { infer: true })) {
      this.logger.log('Market ingestion is disabled on this instance; relaying only');
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

    /**
     * Exactly one process may pull from the provider, or candle volume is
     * counted twice — the same minute's volume written once by each ingester.
     * Which process that is was an environment variable until the lease
     * existed; now it is decided, and it can change hands without a deploy.
     */
    this.leadership.campaign(LeaderLoop.MARKET_INGEST, {
      onAcquired: () => this.startIngesting(),
      onLost: () => this.stopIngesting(),
    });
  }

  /**
   * Become the source of prices rather than a consumer of them.
   *
   * The relay is stopped *first*. Running both would put every tick on this
   * instance's bus twice — once from the provider and once from its own Redis
   * publication — and the integrity gate would then reject the echo as
   * out-of-order, which looks exactly like a broken feed.
   */
  private async startIngesting(): Promise<void> {
    if (this.running) return;
    await this.stopRelay();
    this.provider ??= this.buildSimulator();
    await this.provider.start();
    this.running = true;
    this.scheduleNextPump();
    this.logger.log(
      `Market feed started: ${this.provider.name}, ${this.symbols.codes().length} instrument(s), resolutions ${this.resolutions.join(',')}`,
    );
  }

  /**
   * Stop being the source and go back to listening.
   *
   * The partial candles are flushed on the way out. They were aggregated from
   * ticks this instance saw and nobody else did; dropping them would leave a
   * gap in the minute during which leadership changed, which is precisely the
   * minute somebody will later want to look at.
   */
  private async stopIngesting(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.provider?.stop();
    for (const aggregator of this.aggregators.values()) {
      const candle = aggregator.flush();
      if (candle !== null) await this.persistCandle(candle);
    }
    this.aggregators.clear();
    await this.startRelay();
    this.logger.warn('No longer ingesting market data; relaying instead');
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
    if (this.relaying) return;
    this.relaying = true;
    if (!this.relayListenerBound) {
      this.relayListenerBound = true;
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
    }
    await this.redis.subscriber.subscribe(TICK_CHANNEL);
    this.logger.log('Relaying ticks from market:ticks');
  }

  /** Stop consuming the relay, so this instance can become the source of it. */
  private async stopRelay(): Promise<void> {
    if (!this.relaying) return;
    this.relaying = false;
    await this.redis.subscriber.unsubscribe(TICK_CHANNEL);
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
    // Operator-set reference levels win over the ones written into this file,
    // which were plausible on the day they were written and no longer are.
    const overriddenPrices = parseSimulatorPrices(
      this.config.get('MARKET_SIMULATOR_PRICES', { infer: true }) ?? '',
    );

    const instruments: SimulatedInstrument[] = this.symbols.list().map((definition) => ({
      definition,
      startPrice:
        overriddenPrices[definition.spec.code] ??
        SIMULATOR_START_PRICES[definition.spec.code] ??
        '100',
      dailyVolatility: SIMULATOR_DAILY_VOLATILITY[definition.spec.code] ?? 0.01,
      reversionHalfLifeHours: SIMULATOR_REVERSION_HOURS,
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
 * Reads `MARKET_SIMULATOR_PRICES` — `XAUUSD:3350,BTCUSD:95000`.
 *
 * Validated at boot by the env schema, so a malformed value never reaches
 * here; this only has to split what the schema already accepted. An unknown
 * symbol is ignored rather than rejected, because the set of instruments is a
 * database question and this is configuration.
 */
export function parseSimulatorPrices(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [code, price] = trimmed.split(':');
    if (code === undefined || price === undefined) continue;
    out[code.toUpperCase()] = price;
  }
  return out;
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

/**
 * Standard deviation of one day's move, per instrument.
 *
 * Per *day*, which is the figure anyone can check against a real chart: gold
 * moves about a percent on an ordinary day, ether several. The simulator
 * derives the per-tick step from this and the tick interval.
 *
 * These were per-tick before, and being per-tick is how they came to be wrong
 * by a factor of six hundred: at a 250ms tick there are 345,600 ticks in a day,
 * so ether's "0.0009" — which reads like nothing — was a 53% daily sigma. The
 * terminal duly showed ETHUSD down 37.59% and gold two hundred dollars from
 * where it opened, and every one of those numbers was arithmetically correct.
 */
const SIMULATOR_DAILY_VOLATILITY: Readonly<Record<string, number>> = {
  XAUUSD: 0.011,
  XAGUSD: 0.019,
  BTCUSD: 0.032,
  ETHUSD: 0.041,
  EURUSD: 0.0045,
  AUDUSD: 0.0062,
  GBPUSD: 0.005,
  USDJPY: 0.005,
};

/**
 * How long it takes the pull towards the opening level to close half the gap.
 *
 * A pure random walk has no memory of where it started, so an instance left
 * running over a weekend drifts anywhere at all — which is what happened here:
 * silver started at 69.61 and was quoting 44. Twelve hours is long enough that
 * a session's trading looks like a market and short enough that the price a
 * trader sees on Monday is still one they recognise.
 *
 * A real feed needs none of this. It is a property of pretending.
 */
const SIMULATOR_REVERSION_HOURS = 12;

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
