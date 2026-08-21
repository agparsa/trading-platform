import { type Candle, type InstrumentDefinition, type Resolution, type Tick } from '../types';
import { aggregateTicks } from '../candles';
import type { MarketDataProvider, TickListener, Unsubscribe } from '../provider';

/**
 * A market that plays back an exact, hand-written tick script.
 *
 * This is the provider the trading tests run against. "The same market sequence
 * must produce the same trading result" is only checkable when the market is
 * literally a list of prices — no randomness, no wall clock, no timers.
 */
export class ScriptedMarketDataProvider implements MarketDataProvider {
  readonly name = 'scripted';

  private readonly listeners = new Map<string, Set<TickListener>>();
  private readonly latest = new Map<string, Tick>();
  private readonly emitted: Tick[] = [];
  private cursor = 0;
  private started = false;

  constructor(
    private readonly instruments: readonly InstrumentDefinition[],
    private readonly script: readonly Tick[],
  ) {}

  async listInstruments(): Promise<readonly InstrumentDefinition[]> {
    return this.instruments;
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
    const ticks = this.emitted.filter(
      (t) => t.symbol === symbol && t.timestamp >= from && t.timestamp <= to,
    );
    return aggregateTicks(symbol, resolution, ticks);
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

  /** Emit the next scripted tick. Returns null once the script is exhausted. */
  step(): Tick | null {
    if (!this.started) throw new Error('ScriptedMarketDataProvider.step() before start()');
    const tick = this.script[this.cursor];
    if (tick === undefined) return null;
    this.cursor += 1;
    this.emit(tick);
    return tick;
  }

  /** Emit every remaining scripted tick. */
  drain(): number {
    let count = 0;
    while (this.step() !== null) count += 1;
    return count;
  }

  /** Rewind so the same script can be replayed against fresh state. */
  reset(): void {
    this.cursor = 0;
    this.emitted.length = 0;
    this.latest.clear();
  }

  private emit(tick: Tick): void {
    this.latest.set(tick.symbol, tick);
    this.emitted.push(tick);
    const set = this.listeners.get(tick.symbol);
    if (set === undefined) return;
    for (const listener of set) listener(tick);
  }
}
