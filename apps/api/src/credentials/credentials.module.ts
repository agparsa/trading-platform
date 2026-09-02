import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CredentialsService } from './credentials.service';
import { ApiKeysController } from './api-keys.controller';
import { AdminCredentialsController } from './admin-credentials.controller';

/**
 * Bearer credentials that are not sessions.
 *
 * `AuthModule` for the password check at minting — the one moment a key
 * touches a password, and only to prove the person is at the keyboard.
 * `NotificationsModule` because a key minted or revoked is something its
 * holder must hear about. Exported because the global auth guard turns a
 * presented credential into a principal through this service.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ApiKeysController, AdminCredentialsController],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
