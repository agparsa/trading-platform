import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MarketModule } from '../market/market.module';
import { HealthController } from './health.controller';
import {
  DatabaseHealthIndicator,
  MarketDataHealthIndicator,
  RedisHealthIndicator,
  ScheduledJobsHealthIndicator,
} from './health.indicators';

@Module({
  imports: [TerminusModule, MarketModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    MarketDataHealthIndicator,
    RedisHealthIndicator,
    ScheduledJobsHealthIndicator,
  ],
})
export class HealthModule {}
