import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { overdueSchedules, type ScheduledRun } from '@tp/scheduling-core';
import { withoutTenantScope } from '@tp/tenancy';
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

/**
 * Scheduled jobs, and whether any of them has gone quiet.
 *
 * ## The failure nothing else here can see
 *
 * Every probe above answers "is a dependency up". None of them answers the
 * question that actually goes unanswered in this platform: *is the work that is
 * supposed to happen on a schedule still happening?* A deployment where every
 * worker is `WORKER_ROLE=processor` has a healthy database, a healthy Redis, a
 * healthy feed, and no swap accrual, no reconciliation, no retention sweep and
 * no outbox relay. Nothing anywhere would say so, because the process that
 * would have complained is the one that never ran.
 *
 * So the worker records each scheduled run, and this reads those rows.
 *
 * Reported on its own probe, like the feed, and for the same reason: a stopped
 * sweep is an incident, not a reason to pull an API process out of the load
 * balancer. Alert on this; do not route on it.
 *
 * ## Why an empty table is `down`, not `up`
 *
 * "No rows" is exactly what a deployment with no scheduler looks like, and it
 * is also what a brand-new database looks like. Treating it as healthy would
 * mean the one arrangement this probe exists to catch is the one it reports as
 * fine. A fresh deployment shows this as down until its first sweep lands,
 * which is a few minutes of honest noise in exchange for the thing being
 * visible at all.
 */
@Injectable()
export class ScheduledJobsHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check(key = 'scheduled-jobs'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const tz = this.config.get<string>('TRADING_SERVER_TIMEZONE') ?? 'UTC';

    const rows = await withoutTenantScope('a schedule belongs to the deployment', () =>
      this.prisma.scheduledJobRun.findMany({ orderBy: { name: 'asc' } }),
    );

    if (rows.length === 0) {
      return indicator.down({
        jobs: 0,
        problems: ['no scheduled job has ever recorded a run'],
        note: 'usually no worker is registering schedules — check WORKER_ROLE',
      });
    }

    const runs: ScheduledRun[] = rows.map((row) => ({
      name: row.name,
      cron: row.cron,
      // A run that is still in flight has no finish; judged on its last one.
      lastFinishedAt: row.finishedAt,
      lastOutcome: row.outcome,
    }));
    const problems = overdueSchedules(runs, tz);

    const detail = {
      jobs: rows.length,
      oldestAgeMs: Math.max(
        ...rows.map((row) => Date.now() - (row.lastSucceededAt ?? row.startedAt).getTime()),
      ),
      problems: problems.map((one) => one.says),
    };

    return problems.length === 0 ? indicator.up(detail) : indicator.down(detail);
  }
}
