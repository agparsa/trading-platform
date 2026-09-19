import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationReadService } from './reconciliation.service';
import { ExternalReconciliationService } from './external-reconciliation.service';
import { BrokerConnectionsModule } from '../broker-connections/broker-connections.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [JobsModule, BrokerConnectionsModule, TradingModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationReadService, ExternalReconciliationService],
  exports: [ReconciliationReadService, ExternalReconciliationService],
})
export class ReconciliationModule {}
