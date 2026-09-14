import { createHash } from 'node:crypto';
import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import {
  DatabaseHealthIndicator,
  MarketDataHealthIndicator,
  RedisHealthIndicator,
  ScheduledJobsHealthIndicator,
} from './health.indicators';

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
    return this.health.check([() => this.database.check(), () => this.redis.check()]);
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
    return this.health.check([() => this.scheduledJobs.check()]);
  }
}

/**
 * Which build this is, without saying which revision it is.
 *
 * ## Why there is a marker at all
 *
 * Production sits behind Cloudflare and its origin takes no connection from
 * anywhere the deploy tooling runs, so for a whole weekend the only honest
 * answer to "did the deploy land?" was to ask somebody to read a container log
 * over SSH. A probe that says a service is *alive* but not *which* service is
 * alive cannot tell a successful deploy from one that silently kept the old
 * containers running — which is the failure a deploy check exists to catch.
 *
 * ## Why it is not the commit
 *
 * `/health` is unauthenticated, as a liveness probe has to be. This platform
 * deliberately keeps its route surface off the public internet — Swagger is
 * dev-only, `/metrics` is refused at nginx, the OpenAPI document sits behind a
 * session — and publishing the exact revision of a private repository on an
 * open endpoint would cut against all of it: it tells anyone watching precisely
 * which code is running and therefore which known defect to try.
 *
 * So the endpoint serves a **one-way** marker: the first 12 hex of
 * SHA-256 over the build's commit. Somebody who already knows the candidate
 * commit — the person who just deployed it — can confirm a match in one line.
 * Somebody who does not learns an opaque string. `verify-production.ts` does
 * that comparison, so nobody has to think about the hashing.
 *
 * `unknown` when the image was built without `BUILD_SHA`, which is itself worth
 * knowing: it means the deploy did not stamp its build, and the next person
 * asking "what is running?" will have no way to answer.
 */
export function buildMarker(sha: string | undefined = process.env['BUILD_SHA']): string {
  if (sha === undefined || sha === '' || sha === 'unknown') return 'unknown';
  return createHash('sha256').update(sha.trim()).digest('hex').slice(0, 12);
}
