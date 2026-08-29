import { normalizePrice, toDecimal } from '@tp/financial-core';
import type { Clock } from '../clock';
import { CandleAggregator } from '../candles';
import { SeededRandom } from '../random';
import {
  type Candle,
  type InstrumentDefinition,
  type Resolution,
  Resolution as R,
  type Tick,
} from '../types';
import type { MarketDataProvider, TickListener, Unsubscribe } from '../provider';

export interface SimulatedInstrument {
  readonly definition: InstrumentDefinition;
  /** Price the walk starts from. */
  readonly startPrice: string;
  /** Per-tick volatility as a fraction of price, e.g. 0.0002 for 2 bps. */
  readonly volatility: number;
  /** Half-spread in price units at rest. */
  readonly baseHalfSpread: string;
  /** Milliseconds between ticks for this instrument. */
  readonly tickIntervalMs: number;
}

export interface SimulatorConfig {
  readonly instruments: readonly SimulatedInstrument[];
  readonly seed: number;
  readonly clock: Clock;
  /** Resolutions to keep candle history for. */
  readonly resolutions?: readonly Resolution[];
  /** Candles retained per symbol per resolution. */
  readonly historyDepth?: number;
}

/**
 * Deterministic internal market.
 *
 * The platform ships able to run end to end with no external feed: this is what
 * makes the trading engine independently testable and what lets a developer run
 * `docker compose up` and trade immediately.
 *
 * It owns no timers. `advance(ms)` is called by whatever drives time — a real
 * scheduler in the API process, a loop in a test. That is the only reason the
 * same seed reproduces the same market on every machine.
 */
/**
 * The most ticks one instrument may emit in a single pass.
 *
 * A process paused for a minute — a debugger, a long collection, a container
 * that was descheduled — would otherwise emit hundreds of back-dated ticks at
 * once and spend the recovery replaying a history nobody watched.
 */
const MAX_CATCH_UP_TICKS = 8;

export class InternalMarketSimulator implements MarketDataProvider {
  readonly name = 'internal-simulator';

  private readonly rng: SeededRandom;
  private readonly clock: Clock;
  private readonly instruments: readonly SimulatedInstrument[];
  private readonly resolutions: readonly Resolution[];
  private readonly historyDepth: number;

  private readonly mid = new Map<string, string>();
  private readonly latest = new Map<string, Tick>();
  private readonly nextTickAt = new Map<string, number>();
  private readonly listeners = new Map<string, Set<TickListener>>();
  private readonly aggregators = new Map<string, CandleAggregator>();
  private readonly history = new Map<string, Candle[]>();
  private started = false;

  constructor(config: SimulatorConfig) {
    this.rng = new SeededRandom(config.seed);
    this.clock = config.clock;
    this.instruments = config.instruments;
    this.resolutions = config.resolutions ?? [R.M1, R.M5, R.M15, R.H1];
    this.historyDepth = config.historyDepth ?? 1500;

    for (const instrument of this.instruments) {
      const code = instrument.definition.spec.code;
      this.mid.set(code, instrument.startPrice);
      this.nextTickAt.set(code, this.clock.now());
      for (const resolution of this.resolutions) {
        this.aggregators.set(this.key(code, resolution), new CandleAggregator(code, resolution));
        this.history.set(this.key(code, resolution), []);
      }
    }
  }

  async listInstruments(): Promise<readonly InstrumentDefinition[]> {
    return this.instruments.map((i) => i.definition);
  }

  async getLatestTick(symbol: string): Promise<Tick | null> {
    return this.latest.get(symbol) ?? null;
  }

  async getCandles(
    symbol: string,
    resolution: Resolution,
    from: number,
    to: number,
  ): Promise<readonly Candle[]> {
    const key = this.key(symbol, resolution);
    const closed = this.history.get(key) ?? [];
    const inProgress = this.aggregators.get(key)?.peek();
    const all = inProgress === null || inProgress === undefined ? closed : [...closed, inProgress];
    return all.filter((c) => c.time >= from && c.time <= to);
  }

  subscribe(symbol: string, listener: TickListener): Unsubscribe {
    const set = this.listeners.get(symbol) ?? new Set<TickListener>();
    set.add(listener);
    this.listeners.set(symbol, set);
    return () => {
      set.delete(listener);
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /**
   * Produce every tick due up to the clock's current time.
   *
   * The caller advances the clock first, then calls this. Ticks are generated in
   * a fixed instrument order and a fixed time order, so the sequence depends
   * only on the seed and the elapsed time — never on scheduling jitter.
   *
   * ## The newest tick is stamped *now*, and the grid re-anchors
   *
   * This used to advance each instrument's schedule by exactly one interval per
   * tick emitted, from wherever it started. On a grid that is running on time
   * that is the same thing; on one that is late it is not, and the lateness
   * never came back.
   *
   * A load run found what that costs. The pump loop runs a little late every
   * pass — it always does, it is a timer — and under load a great deal late. The
   * timestamps stayed on their original 250ms grid while the wall clock moved
   * on, so within a minute the newest "current" price was stamped fourteen
   * seconds ago. `requireFresh` then refused every order with `STALE_QUOTE`, and
   * it was right to: a price observed fourteen seconds ago is not a price to
   * trade on. The engine was correct. The timestamp was a lie.
   *
   * So: the last tick of a pass carries the clock's current time, because that
   * is when it was observed, and the schedule re-anchors to `now + interval`
   * rather than to where the grid thought it should be. Drift cannot accumulate.
   *
   * The catch-up is bounded too. A process paused for a minute — a debugger, a
   * long GC, a container that was descheduled — would otherwise emit hundreds of
   * back-dated ticks in one pass and spend the recovery replaying a history
   * nobody watched.
   */
  pump(): readonly Tick[] {
    if (!this.started) return [];
    const now = this.clock.now();
    const produced: Tick[] = [];

    for (const instrument of this.instruments) {
      const code = instrument.definition.spec.code;
      const at = this.nextTickAt.get(code) ?? now;
      if (at > now) continue;

      const interval = Math.max(1, instrument.tickIntervalMs);
      const steps = Math.min(Math.floor((now - at) / interval) + 1, MAX_CATCH_UP_TICKS);

      for (let i = 0; i < steps; i += 1) {
        // The last one is an observation of *now*; the ones before it fill in
        // the grid so a candle has the shape it would have had.
        const stamp = i === steps - 1 ? now : at + i * interval;
        produced.push(this.generate(instrument, stamp));
      }

      this.nextTickAt.set(code, now + interval);
    }

    return produced;
  }

  private generate(instrument: SimulatedInstrument, timestamp: number): Tick {
    const spec = instrument.definition.spec;
    const previousMid = toDecimal(this.mid.get(spec.code) ?? instrument.startPrice);

    // Multiplicative random walk: keeps prices positive and makes volatility
    // proportional to price, which is how real instruments behave.
    const shock = this.rng.normal() * instrument.volatility;
    const rawMid = previousMid.mul(1 + shock);
    const newMid = normalizePrice(spec, rawMid.lte(0) ? previousMid : rawMid);
    this.mid.set(spec.code, newMid.toString());

    // Spread widens with the size of the move, as it does around news.
    const widening = 1 + Math.abs(shock) / Math.max(instrument.volatility, Number.EPSILON) / 4;
    const halfSpread = toDecimal(instrument.baseHalfSpread).mul(toDecimal(widening.toFixed(6)));

    const bid = normalizePrice(spec, newMid.minus(halfSpread));
    const ask = normalizePrice(spec, newMid.plus(halfSpread));
    const volume = toDecimal(Math.max(1, Math.round(this.rng.between(1, 40))).toString()).div(100);

    const tick: Tick = {
      symbol: spec.code,
      bid: bid.toString(),
      ask: ask.toString(),
      timestamp,
      volume: volume.toString(),
    };

    this.latest.set(spec.code, tick);
    this.record(tick);
    const set = this.listeners.get(spec.code);
    if (set !== undefined) for (const listener of set) listener(tick);
    return tick;
  }

  private record(tick: Tick): void {
    for (const resolution of this.resolutions) {
      const key = this.key(tick.symbol, resolution);
      const closed = this.aggregators.get(key)?.push(tick);
      if (closed === null || closed === undefined) continue;
      const bucket = this.history.get(key);
      if (bucket === undefined) continue;
      bucket.push(closed);
      if (bucket.length > this.historyDepth) bucket.splice(0, bucket.length - this.historyDepth);
    }
  }

  private key(symbol: string, resolution: Resolution): string {
    return `${symbol}:${resolution}`;
  }
}
