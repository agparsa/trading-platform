import { Global, Module } from '@nestjs/common';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';

/** Global: the trading engine asks it what each account pays. */
@Global()
@Module({
  controllers: [FeesController],
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
