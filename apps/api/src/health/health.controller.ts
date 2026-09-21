import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { buildMarker } from '@tp/crypto-core';
import { Public } from '../common/decorators/public.decorator';
import {
  DatabaseHealthIndicator,
  MarketDataHealthIndicator,
  RedisHealthIndicator,
  ScheduledJobsHealthIndicator,
  TenantIsolationHealthIndicator,
  WorkerHealthIndicator,
} from './health.indicators';

/**
 * Every path this controller serves, and the single source for the global
 * prefix's exclusion list.
 *
 * It was a hand-written literal in `main.ts` and it went out of date the moment
 * a probe was added. `/health/jobs` — the watchdog for a schedule that has
 * stopped, the one check that can fail on a deployment where every other one
 * passes — answered **404** at the path `verify:production`, `runbook.md`,
 * `worker.md`, `backup-restore.md` and `observability.md` all call it by. It
 * was being served under the prefix, at `/api/health/jobs`, and nothing
 * compared the two lists.
 *
 * `health-routes.test.ts` now does, in both directions.
 */
export const HEALTH_ROUTES = [
  'health',
  'ready',
  'health/market',
  'health/jobs',
  'health/tenancy',
] as const;

/**
 * Probes live outside the versioned API surface. An orchestrator's health
 * check must not break because the trading API moved from v1 to v2.
 */
/**
 * Probes are public and unthrottled: an orchestrator polls them constantly, and
 * a rate-limited health check would report the service as down under load —
 * the precise moment the reading needs to be trustworthy.
 */
@Public()
@SkipThrottle()
@ApiTags('health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly marketData: MarketDataHealthIndicator,
    private readonly scheduledJobs: ScheduledJobsHealthIndicator,
    private readonly tenantIsolation: TenantIsolationHealthIndicator,
    private readonly workers: WorkerHealthIndicator,
  ) {}

  /**
   * Liveness. Answers "is this process running?" and nothing else — it must not
   * touch the database, or a brief database blip would make the orchestrator
   * kill every healthy API pod at once.
   *
   * It also answers **which build is running**, as `build` — see `buildMarker`.
   */
  @Version(VERSION_NEUTRAL)
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string; uptimeSeconds: number; build: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      build: buildMarker(),
    };
  }

  /** Readiness. Answers "can this process serve traffic?" — dependencies included. */
  @Version(VERSION_NEUTRAL)
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe including database and Redis' })
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.database.check(),
      () => this.redis.check(),
      /**
       * Isolation is a routing decision here, unlike the feed and the
       * schedules, and only in one case: the operator set `DATABASE_URL_TENANT`
       * and the policies do not apply. A deployment that asked to be isolated
       * and is not should not take traffic — that is what the boot-time refusal
       * means, kept by a process that is already running. Every other state
       * reports up. See `TenantIsolationHealthIndicator`.
       */
      () => this.tenantIsolation.check(),
    ]);
  }

  /**
   * Tenant isolation, reported on its own because the interesting state is the
   * one readiness deliberately ignores.
   *
   * On the single-role deployment — the default, and what `.env.example`
   * ships — layer two is off and readiness says up, correctly: it is a posture
   * its operator chose. That posture still needs to be visible somewhere other
   * than a boot log written months ago, which is here, and in
   * `tp_tenant_isolation`, and in `verify:production`.
   */
  @Version(VERSION_NEUTRAL)
  @Get('health/tenancy')
  @ApiOperation({ summary: 'Whether row-level security applies to this connection' })
  @HealthCheck()
  tenancy() {
    return this.health.check([() => this.tenantIsolation.check()]);
  }

  /**
   * Feed health, reported separately from readiness.
   *
   * A dead upstream feed is an incident, not a reason to take this process out
   * of the load balancer: it can still serve history, account state and the
   * ledger, and pulling it would take away the screen that tells traders what
   * has happened. Alert on this; do not route on it.
   */
  @Version(VERSION_NEUTRAL)
  @Get('health/market')
  @ApiOperation({ summary: 'Market feed health and integrity-gate counters' })
  @HealthCheck()
  market() {
    return this.health.check([() => this.marketData.check()]);
  }

  /**
   * Scheduled jobs, reported separately for the same reason as the feed.
   *
   * A stopped sweep is an incident and not a routing decision: the API can
   * still take orders, serve history and pay out. What it cannot do is notice
   * on its own that swap accrual has not run for three days, which is what this
   * is for. Alert on it; do not route on it.
   */
  @Version(VERSION_NEUTRAL)
  @Get('health/jobs')
  @ApiOperation({ summary: 'Whether every scheduled job is still running on time' })
  @HealthCheck()
  jobs() {
    /**
     * Two indicators, one question: is the background work happening. The
     * schedule log says whether it *has* been (from the database); the
     * heartbeat says whether anything is there to do it *now*, and on which
     * build (from Redis). See `WorkerHealthIndicator` for why both.
     */
    return this.health.check([() => this.scheduledJobs.check(), () => this.workers.check()]);
  }
}

/**
 * Re-exported so existing callers and tests keep their import path. The rule
 * lives in `@tp/crypto-core` now, because the worker answers the same question
 * on its heartbeat and the real-time service on its handshake.
 */
export { buildMarker };
