import { Global, Module } from '@nestjs/common';
import { KillSwitchService } from './kill-switch.service';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

/**
 * Global because the kill switch is consulted on the order path, which lives in
 * a module that must not import an operations module that imports it back.
 */
@Global()
@Module({
  controllers: [OperationsController],
  providers: [KillSwitchService, OperationsService],
  exports: [KillSwitchService, OperationsService],
})
export class OperationsModule {}
