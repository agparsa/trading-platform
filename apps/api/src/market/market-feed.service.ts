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

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
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
      this.logger.warn(
        'Market ingestion is disabled on this instance (MARKET_INGEST_ENABLED=false)',
      );
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
    await this.provider?.stop();
    // Persist the partial candles rather than discarding a minute of data.
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
    for (const tick of ticks) await this.onTick(tick);
  }

  private async onTick(tick: Tick): Promise<void> {
    const instrument = this.symbols.find(tick.symbol);
    // Outside its session an instrument produces no tradeable price. Publishing
    // one would let a stop fire on a weekend.
    if (instrument === undefined || !isSessionOpen(instrument.session, tick.timestamp)) return;

    await this.quotes.publish(tick);
    this.metrics.marketTicks.inc({ symbol: tick.symbol });
    await this.redis.publisher.publish(TICK_CHANNEL, JSON.stringify(tick));

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
      if (closed !== null) await this.persistCandle(closed);
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
  EURUSD: '1.08750',
  AUDUSD: '0.71580',
};

const SIMULATOR_VOLATILITY: Readonly<Record<string, number>> = {
  XAUUSD: 0.0002,
  XAGUSD: 0.0004,
  BTCUSD: 0.0006,
  EURUSD: 0.00008,
  AUDUSD: 0.0001,
};

const SIMULATOR_HALF_SPREAD: Readonly<Record<string, string>> = {
  XAUUSD: '0.07',
  XAGUSD: '0.0125',
  BTCUSD: '2.50',
  EURUSD: '0.00005',
  AUDUSD: '0.000005',
};
