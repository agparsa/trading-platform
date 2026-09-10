import { Global, Module } from '@nestjs/common';
import {
  AdminFeaturesController,
  BrokerFeaturesController,
  FeaturesController,
} from './features.controller';
import { FeaturesService } from './features.service';

/** Global: enforcement points sit in trading, webhooks and venue execution. */
@Global()
@Module({
  controllers: [FeaturesController, AdminFeaturesController, BrokerFeaturesController],
  providers: [FeaturesService],
  exports: [FeaturesService],
})
export class FeaturesModule {}
