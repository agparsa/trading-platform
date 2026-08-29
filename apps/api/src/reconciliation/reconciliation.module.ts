import { Module } from '@nestjs/common';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationReadService } from './reconciliation.service';

@Module({
  controllers: [ReconciliationController],
  providers: [QueuePublisher, ReconciliationReadService],
  exports: [QueuePublisher, ReconciliationReadService],
})
export class ReconciliationModule {}
