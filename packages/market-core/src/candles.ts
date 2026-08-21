import { type Decimal, toDecimal } from '@tp/financial-core';
import { type Candle, type Resolution, resolutionMs, type Tick } from './types';

/** Start of the bucket a timestamp belongs to, aligned to the epoch grid. */
export function bucketStart(timestampMs: number, resolution: Resolution): number {
  const size = resolutionMs(resolution);
  return Math.floor(timestampMs / size) * size;
}

/**
 * Streaming OHLCV aggregator for one symbol at one resolution.
 *
 * Candles are built from the *bid*, matching how price charts are drawn on
 * every broker terminal: the chart shows what a long position would be marked
 * at, not the mid. Mixing bid candles with mid-priced P&L is a classic source
 * of "the chart says I was in profit" support tickets.
 */
export class CandleAggregator {
  private current: MutableCandle | null = null;

  constructor(
    private readonly symbol: string,
    private readonly resolution: Resolution,
  ) {}

  /**
   * Feed a tick. Returns the candle that just *closed*, if this tick opened a
   * new bucket — so a caller can persist and broadcast completed candles
   * without polling for bucket boundaries.
   */
  push(tick: Tick): Candle | null {
    if (tick.symbol !== this.symbol) {
      throw new Error(`Aggregator for ${this.symbol} received a ${tick.symbol} tick`);
    }
    const start = bucketStart(tick.timestamp, this.resolution);
    const price = toDecimal(tick.bid);
    const volume = toDecimal(tick.volume);

    if (this.current === null) {
      this.current = this.open(start, price, volume);
      return null;
    }

    if (start > this.current.time) {
      const completed = this.freeze(this.current);
      this.current = this.open(start, price, volume);
      return completed;
    }

    if (start < this.current.time) {
      // Out-of-order tick. Dropping it silently would corrupt the candle; the
      // caller decides whether to backfill.
      return null;
    }

    if (price.gt(this.current.high)) this.current.high = price;
    if (price.lt(this.current.low)) this.current.low = price;
    this.current.close = price;
    this.current.volume = this.current.volume.plus(volume);
    return null;
  }

  /** The in-progress candle, or null before the first tick. */
  peek(): Candle | null {
    return this.current === null ? null : this.freeze(this.current);
  }

  /** Close the current bucket explicitly (session end, shutdown). */
  flush(): Candle | null {
    if (this.current === null) return null;
    const completed = this.freeze(this.current);
    this.current = null;
    return completed;
  }

  private open(time: number, price: Decimal, volume: Decimal): MutableCandle {
    return { time, open: price, high: price, low: price, close: price, volume };
  }

  private freeze(c: MutableCandle): Candle {
    return {
      symbol: this.symbol,
      resolution: this.resolution,
      time: c.time,
      open: c.open.toString(),
      high: c.high.toString(),
      low: c.low.toString(),
      close: c.close.toString(),
      volume: c.volume.toString(),
    };
  }
}

interface MutableCandle {
  time: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

/** Batch-aggregate ticks, e.g. when backfilling history. */
export function aggregateTicks(
  symbol: string,
  resolution: Resolution,
  ticks: readonly Tick[],
): readonly Candle[] {
  const aggregator = new CandleAggregator(symbol, resolution);
  const out: Candle[] = [];
  for (const tick of ticks) {
    const closed = aggregator.push(tick);
    if (closed !== null) out.push(closed);
  }
  const last = aggregator.flush();
  if (last !== null) out.push(last);
  return out;
}
