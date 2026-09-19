import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import { TradingNotificationsService } from './trading-notifications.service';

/**
 * Imports `JobsModule` for its `QueuePublisher` — one publisher, one Redis
 * connection, one place its options are set. A second copy would open a second
 * connection to publish to the same queues.
 *
 * This used to import `ReconciliationModule` to reach the same instance, which
 * is how the intent above was carried before there was a module to hold it: an
 * arrow from notifications to reconciliation that existed for a shared
 * connection rather than for anything either module does.
 *
 * `EventsService` is not imported: `EventsModule` is `@Global()`, and importing
 * it here would point an arrow from notifications back at realtime, which
 * already imports this module.
 */
@Module({
  imports: [JobsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PreferencesService, TradingNotificationsService],
  exports: [NotificationsService, PreferencesService],
})
export class NotificationsModule {}
