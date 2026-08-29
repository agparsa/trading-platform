import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketModule } from '../market/market.module';
import { TradingModule } from '../trading/trading.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';
import { ExposureIndex } from './exposure-index';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import type { Env } from '../config/env.schema';

@Module({
  imports: [MarketModule, TradingModule, AuthModule],
  providers: [
    RealtimeGateway,
    RealtimeService,
    {
      /**
       * Built by hand so the rebuild interval is configuration rather than a
       * literal buried in a constructor. An operator tuning it should not have
       * to redeploy to find out whether it helped.
       */
      provide: ExposureIndex,
      inject: [PrismaService, EventsService, ConfigService],
      useFactory: (
        prisma: PrismaService,
        events: EventsService,
        config: ConfigService<Env, true>,
      ) =>
        new ExposureIndex(
          prisma,
          events,
          config.getOrThrow('EXPOSURE_INDEX_REFRESH_MS', { infer: true }),
        ),
    },
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
