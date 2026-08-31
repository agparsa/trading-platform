import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/**
 * Exports `DevicesService` because the notification fan-out needs
 * `pushTargets`. Nothing else outside this module has a reason to reach a
 * device row, and nothing outside it can reach a push token.
 */
@Module({
  imports: [CryptoModule, AuditModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
