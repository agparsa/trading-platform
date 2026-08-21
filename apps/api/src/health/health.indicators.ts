import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
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
