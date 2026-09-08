import { Module } from '@nestjs/common';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationReadService } from './reconciliation.service';
import { ExternalReconciliationService } from './external-reconciliation.service';
import { BrokerConnectionsModule } from '../broker-connections/broker-connections.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [BrokerConnectionsModule, TradingModule],
  controllers: [ReconciliationController],
  providers: [QueuePublisher, ReconciliationReadService, ExternalReconciliationService],
  exports: [QueuePublisher, ReconciliationReadService, ExternalReconciliationService],
})
export class ReconciliationModule {}
