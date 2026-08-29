import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PlatformMetricsService } from './platform-metrics.service';

/**
 * Kept apart from `MetricsModule`, which is global and holds only the registry.
 *
 * This one needs the gateway and the quote cache, so it must be able to import
 * their modules — and a global module that imported half the application would
 * make every dependency cycle in the codebase this module's problem.
 */
@Module({
  imports: [MarketModule, RealtimeModule],
  providers: [PlatformMetricsService],
  exports: [PlatformMetricsService],
})
export class PlatformMetricsModule {}
