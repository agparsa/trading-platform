import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { MarketIntegrityService } from '../market/market-integrity.service';
import { QuoteService } from '../market/quote.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  async check(key = 'database'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const start = Date.now();
    try {
      await this.prisma.ping();
      return indicator.up({ latencyMs: Date.now() - start });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - start,
        // Never surface the connection string, which lives in the driver message.
        message: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }
}

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async check(key = 'redis'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const start = Date.now();
    try {
      await this.redis.ping();
      return indicator.up({ latencyMs: Date.now() - start });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - start,
        message: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }
}

/**
 * Market data health.
 *
 * Answers a question the database and Redis probes cannot: *are we being told
 * the price?* An API whose dependencies are all up and whose feed died an hour
 * ago is not healthy — it will refuse every order with STALE_QUOTE and mark
 * every position at a price from another market.
 *
 * Deliberately **not** part of readiness. A process pulled out of the load
 * balancer because the upstream feed stopped is a process that cannot serve the
 * history, the account state or the ledger either, and traders would lose the
 * screen that tells them what has happened. Feed health is reported so it can be
 * alerted on; it is not grounds for killing pods.
 */
@Injectable()
export class MarketDataHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly quotes: QuoteService,
    private readonly integrity: MarketIntegrityService,
  ) {}

  check(key = 'market-data'): HealthIndicatorResult {
    const indicator = this.health.check(key);
    const ageMs = this.quotes.newestTickAge();
    const summary = this.integrity.summary();

    const detail = {
      newestTickAgeMs: ageMs,
      instrumentsPriced: summary.symbols,
      ticksRejected: summary.rejectedTotal,
      // Named, not counted. "Three symbols are being refused" prompts a
      // different question from "XAUUSD is being refused", and only one of them
      // can be acted on.
      inRejectionRun: summary.symbolsInRejectionRun,
    };

    // No tick has ever arrived. On a fresh process that is startup, not a
    // fault, and saying "down" would make every deploy look like an outage.
    if (ageMs === null) return indicator.up({ ...detail, note: 'no ticks yet' });

    return ageMs > STALE_FEED_MS ? indicator.down(detail) : indicator.up(detail);
  }
}

/**
 * How old the newest tick across all instruments may be before the feed counts
 * as down.
 *
 * Much longer than `QUOTE_MAX_AGE_MS`, and for a different purpose. That one
 * decides whether a single instrument may be traded on; this one decides whether
 * the *feed* has stopped — and every instrument being quiet at once is what a
 * dead feed looks like. A minute of silence across the whole platform is not a
 * quiet market.
 */
const STALE_FEED_MS = 60_000;
