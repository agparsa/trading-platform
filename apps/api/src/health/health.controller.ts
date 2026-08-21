import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatabaseHealthIndicator, RedisHealthIndicator } from './health.indicators';

/**
 * Probes live outside the versioned API surface. An orchestrator's health
 * check must not break because the trading API moved from v1 to v2.
 */
@ApiTags('health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
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
}
