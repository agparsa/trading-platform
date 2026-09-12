import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../common/audit/audit.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/**
 * Exports `DevicesService` because the notification fan-out needs
 * `pushTargets`, and the admin module needs the staff-facing list and
 * revocation (§13-14). Nothing outside this module can reach a push token: the
 * admin methods return the same `toDto` shape the owner's own list uses.
 */
@Module({
  imports: [CryptoModule, AuditModule, AuthModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
