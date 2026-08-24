import { Injectable, Logger } from '@nestjs/common';
import type { Candle } from '@tp/market-core';

export interface CandleUpdate {
  readonly candle: Candle;
  /** True when this is the final state of a bucket that has just closed. */
  readonly closed: boolean;
}

export type CandleHandler = (update: CandleUpdate) => void | Promise<void>;

/**
 * In-process fan-out for candle updates.
 *
 * Separate from `TickBus` because the consumers are different: a stop-loss cares
 * about every tick, a chart cares about the bar those ticks are building. Mixing
 * them would make the trigger engine walk past candle work on the hot path.
 *
 * `subscriberCount` is read by the market feed before it snapshots the
 * in-progress bars: with no chart connected, that work is skipped entirely
 * rather than performed and discarded.
 */
@Injectable()
export class CandleBus {
  private readonly logger = new Logger(CandleBus.name);
  private readonly handlers = new Set<CandleHandler>();

  subscribe(handler: CandleHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(update: CandleUpdate): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(update);
      } catch (error) {
        this.logger.error({ err: error, symbol: update.candle.symbol }, 'Candle handler failed');
      }
    }
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}
