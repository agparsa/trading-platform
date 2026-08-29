import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Imports `ReconciliationModule` for its `QueuePublisher` — one publisher, one
 * Redis connection, one place its options are set. A second copy would open a
 * second connection to publish to the same queues.
 */
@Module({
  imports: [ReconciliationModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
