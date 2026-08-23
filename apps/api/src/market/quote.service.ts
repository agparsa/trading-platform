import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isTickFresh, type Tick } from '@tp/market-core';
import { spreadOf, toDecimal } from '@tp/financial-core';
import { DomainError, type QuoteDto, TradingErrorCode } from '@tp/shared-types';
import { RedisService } from '../redis/redis.service';
import type { Env } from '../config/env.schema';

const QUOTE_KEY = (symbol: string) => `quote:${symbol}`;

/**
 * The current price of everything.
 *
 * Quotes live in Redis and in a process-local map. The local copy answers the
 * engine's own reads without a network hop; Redis is what lets a second API
 * instance, or the worker, see the same price.
 *
 * Redis is a cache here and nothing more. Losing it costs a moment of staleness
 * until the next tick, not a financial inconsistency.
 */
@Injectable()
export class QuoteService {
  private readonly local = new Map<string, Tick>();

  constructor(
    private readonly redis: RedisService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async publish(tick: Tick): Promise<void> {
    this.local.set(tick.symbol, tick);
    // A short TTL means a symbol whose feed dies stops answering rather than
    // serving a price from an hour ago to a process that just started.
    await this.redis.client.set(QUOTE_KEY(tick.symbol), JSON.stringify(tick), 'EX', 60);
  }

  /** Latest known tick, local first, then Redis. Null when nothing is known. */
  async latest(symbol: string): Promise<Tick | null> {
    const local = this.local.get(symbol);
    if (local !== undefined) return local;

    const raw = await this.redis.client.get(QUOTE_KEY(symbol));
    if (raw === null) return null;
    const tick = JSON.parse(raw) as Tick;
    this.local.set(symbol, tick);
    return tick;
  }

  /**
   * The tick the engine is allowed to trade on.
   *
   * Distinguishes "we have never had a price" from "the price we have is too
   * old", because they mean different things operationally: the first is a
   * configuration or startup problem, the second is a feed outage.
   */
  async requireFresh(symbol: string, nowMs: number = Date.now()): Promise<Tick> {
    const tick = await this.latest(symbol);
    if (tick === null) {
      throw new DomainError(
        TradingErrorCode.NO_QUOTE_AVAILABLE,
        `No price has been received for ${symbol}`,
        { symbol },
      );
    }
    if (!isTickFresh(tick, nowMs, { maxAgeMs: this.maxAgeMs() })) {
      throw new DomainError(
        TradingErrorCode.STALE_QUOTE,
        `The last ${symbol} price is too old to trade on`,
        { symbol, ageMs: nowMs - tick.timestamp, maxAgeMs: this.maxAgeMs() },
      );
    }
    return tick;
  }

  toDto(tick: Tick): QuoteDto {
    return {
      symbol: tick.symbol,
      bid: tick.bid,
      ask: tick.ask,
      spread: spreadOf(tick).toString(),
      timestamp: tick.timestamp,
    };
  }

  /** Quotes for a set of symbols; symbols with no price are simply absent. */
  async snapshot(symbols: readonly string[]): Promise<QuoteDto[]> {
    const quotes: QuoteDto[] = [];
    for (const symbol of symbols) {
      const tick = await this.latest(symbol);
      if (tick !== null) quotes.push(this.toDto(tick));
    }
    return quotes;
  }

  /** Age of the newest tick across all symbols — the feed-health signal. */
  newestTickAge(nowMs: number = Date.now()): number | null {
    let newest: number | null = null;
    for (const tick of this.local.values()) {
      if (newest === null || tick.timestamp > newest) newest = tick.timestamp;
    }
    return newest === null ? null : nowMs - newest;
  }

  private maxAgeMs(): number {
    return this.config.getOrThrow('QUOTE_MAX_AGE_MS', { infer: true });
  }
}

/** Exported for the health indicator: a book that is crossed is a broken feed. */
export function isBookSane(tick: Tick): boolean {
  return toDecimal(tick.bid).gt(0) && toDecimal(tick.ask).gt(toDecimal(tick.bid));
}
