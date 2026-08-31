import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import { TradingNotificationsService } from './trading-notifications.service';

/**
 * Imports `ReconciliationModule` for its `QueuePublisher` — one publisher, one
 * Redis connection, one place its options are set. A second copy would open a
 * second connection to publish to the same queues.
 *
 * `EventsService` is not imported: `EventsModule` is `@Global()`, and importing
 * it here would point an arrow from notifications back at realtime, which
 * already imports this module.
 */
@Module({
  imports: [ReconciliationModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PreferencesService, TradingNotificationsService],
  exports: [NotificationsService, PreferencesService],
})
export class NotificationsModule {}
