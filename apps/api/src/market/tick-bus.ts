import { Injectable, Logger } from '@nestjs/common';
import type { Tick } from '@tp/market-core';

export type TickHandler = (tick: Tick) => void | Promise<void>;

/**
 * In-process fan-out for ticks.
 *
 * The market feed publishes here; the trigger engine and the WebSocket gateway
 * subscribe. It exists to break a dependency cycle — the feed must not know
 * about the trading engine — and it is deliberately not Redis: these consumers
 * live in the same process as the producer, and a network round trip between
 * "price moved" and "close the position" is latency nobody is paying for.
 *
 * Handlers are invoked in registration order and are awaited, so a slow handler
 * delays the next tick rather than racing it. Ticks are ordered events; running
 * them concurrently would let a stop evaluate against a price that has already
 * been superseded.
 */
@Injectable()
export class TickBus {
  private readonly logger = new Logger(TickBus.name);
  private readonly handlers = new Set<TickHandler>();

  subscribe(handler: TickHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(tick: Tick): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(tick);
      } catch (error) {
        // One failing consumer must not stop the feed or the others.
        this.logger.error({ err: error, symbol: tick.symbol }, 'Tick handler failed');
      }
    }
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}
