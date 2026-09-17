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
      /**
       * Named, not just counted.
       *
       * A count cannot answer "is the backup among them", and a schedule that
       * has never run once leaves no row at all — which is exactly what a
       * missing scheduler or an unstarted backup container looks like. The
       * probe reports what it has; whoever knows what this deployment is
       * *supposed* to have compares the two. `verify:production` does.
       */
      names: rows.map((row) => row.name),
      oldestAgeMs: Math.max(
        ...rows.map((row) => Date.now() - (row.lastSucceededAt ?? row.startedAt).getTime()),
      ),
      problems: problems.map((one) => one.says),
    };

    return problems.length === 0 ? indicator.up(detail) : indicator.down(detail);
  }
}

/**
 * Whether row-level security actually applies to the role this process
 * connected as.
 *
 * Until now this was one line in the boot log, and on the default deployment
 * (`DATABASE_URL_TENANT` unset) it is a *warning nobody was ever meant to act
 * on* — which is how a reader learns to skip the line that matters. There was
 * no probe, no gauge and no production check: the platform's own answer to its
 * most important safety question was computed carefully and then whispered.
 *
 * **What is deliberately not in the payload.** `/health/*` is public, as an
 * orchestrator's probe has to be. The role name and the probe's reason —
 * "it owns the table, or it is a superuser, or the policy is missing" — are
 * database internals and stay in the log. What is published is the state and
 * whether the operator asked for the two-role setup, which is what somebody
 * watching a deployment needs and is not a map of the way in.
 */
@Injectable()
export class TenantIsolationHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  async check(key = 'tenant-isolation'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const configured = this.prisma.tenantRoleConfigured;
    const state = await this.prisma.resolveTenantIsolation();
    const detail = { enforced: state.enforced, configured } as const;

    if (state.enforced === true) return indicator.up(detail);

    /**
     * Unknown and asked for is **up**, and that is not a softening.
     *
     * Unknown means the probe table is empty, which on a two-role deployment is
     * a brand-new install. Taking readiness down there would mean the platform
     * could never serve the request that creates its first user, and would
     * therefore never be able to prove the thing being checked. The state is
     * published, the gauge carries it, and `resolveTenantIsolation` keeps
     * asking until it is definite.
     */
    if (state.enforced === 'unknown') {
      return indicator.up({
        ...detail,
        note: 'no rows to read yet, so the policies cannot be proved either way',
      });
    }

    if (!configured) {
      /**
       * Not asked for, and correspondingly not a routing decision. This is the
       * documented single-role posture: layer one alone, which every other test
       * in the suite exercises. Alert on it; do not pull the deployment out of
       * the load balancer for a choice its operator made.
       */
      return indicator.up({
        ...detail,
        note: 'relying on the Prisma extension alone; set DATABASE_URL_TENANT for the second layer',
      });
    }

    /**
     * Asked for, and definitely absent. `docs/multi-tenancy.md` promises the
     * process refuses to start on this pair; refusing to *serve* is the same
     * promise kept by a process that is already up.
     */
    return indicator.down({
      ...detail,
      note: 'DATABASE_URL_TENANT is set and row-level security does not apply to this connection',
    });
  }
}
