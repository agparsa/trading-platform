import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import {
  DatabaseHealthIndicator,
  MarketDataHealthIndicator,
  RedisHealthIndicator,
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
  ) {}

  /**
   * Liveness. Answers "is this process running?" and nothing else — it must not
   * touch the database, or a brief database blip would make the orchestrator
   * kill every healthy API pod at once.
   */
  @Version(VERSION_NEUTRAL)
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
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
}
