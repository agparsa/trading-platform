import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isBookSane, isTickFresh, type Tick } from '@tp/market-core';
import { spreadOf } from '@tp/financial-core';
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

  /**
   * Make a tick the current price.
   *
   * Refuses a tick older than the one already held for that symbol, and returns
   * `false` when it does. `MarketIntegrityService` is the real gate and runs
   * before anything reaches here; this is the second line, and it exists because
   * `publish` is reachable from more than one place — the ingest loop, the
   * relay on a non-ingesting instance, tests — and "the newest tick wins" is a
   * property of *the quote*, not of any one caller.
   *
   * Overwriting unconditionally was the previous behaviour, and out-of-order
   * delivery is normal on any real transport. A tick that arrives late and
   * overwrites a newer one rewinds the price, and the rewound price then decides
   * whether a stop fires.
   */
  async publish(tick: Tick): Promise<boolean> {
    const held = this.local.get(tick.symbol);
    if (held !== undefined && tick.timestamp < held.timestamp) return false;

    this.local.set(tick.symbol, tick);
    // A short TTL means a symbol whose feed dies stops answering rather than
    // serving a price from an hour ago to a process that just started.
    await this.redis.client.set(QUOTE_KEY(tick.symbol), JSON.stringify(tick), 'EX', 60);
    return true;
  }

  /**
   * Latest known tick, local first, then Redis. Null when nothing is known.
   *
   * The Redis copy is checked for sanity before it is adopted. It is written by
   * whichever process ingests, and a corrupted or truncated value there would
   * otherwise become this process's price with nothing between it and the
   * engine. Local values have already passed the gate.
   */
  async latest(symbol: string): Promise<Tick | null> {
    const local = this.local.get(symbol);
    if (local !== undefined) return local;

    const raw = await this.redis.client.get(QUOTE_KEY(symbol));
    if (raw === null) return null;

    let tick: Tick;
    try {
      tick = JSON.parse(raw) as Tick;
    } catch {
      return null;
    }
    if (typeof tick?.symbol !== 'string' || !isBookSane(tick)) return null;

    this.local.set(symbol, tick);
    return tick;
  }

  /**
   * Drop the cached price for a symbol.
   *
   * The local map is a cache with no expiry of its own — Redis has a TTL, this
   * does not — so a price that must not be used again has to be removed by
   * hand. Two cases need it: an instrument being delisted, and an operator who
   * has established that a particular quote was poisoned and does not want the
   * ordering rule in `publish` to keep it in place ahead of a correction.
   *
   * It does not clear Redis. The next `latest` will re-read from there, which
   * is what the operator wants when the correction is coming from whichever
   * process ingests.
   */
  forget(symbol: string): void {
    this.local.delete(symbol);
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

/**
 * Re-exported so callers that already depend on the quote service do not have
 * to reach past it. The definition lives in `@tp/market-core` beside the gate
 * that uses it — one answer to "is this book broken", not two that can drift.
 */
export { isBookSane };
