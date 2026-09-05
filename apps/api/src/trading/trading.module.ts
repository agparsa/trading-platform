import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { MarketModule } from '../market/market.module';
import { ConversionService } from '../market/conversion.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import { PositionsService } from './positions.service';
import { RiskContextBuilder } from './risk-context.builder';
import { RiskLimitsService } from './risk-limits.service';
import { TriggerEngineService } from './trigger-engine.service';
import { TradingController } from './trading.controller';
import { TradingThrottle } from './trading-throttle.service';
import { OutboxModule } from '../outbox/outbox.module';
import { BrokerConnectionsModule } from '../broker-connections/broker-connections.module';
import { ExternalExecutionService } from './external-execution.service';
import { SnapshotService } from './snapshot.service';
import { VenueRecoveryService } from './venue-recovery.service';
import { VenueRecoveryController } from './venue-recovery.controller';

@Module({
  imports: [MarketModule, AccountsModule, OutboxModule, BrokerConnectionsModule],
  controllers: [TradingController, VenueRecoveryController],
  providers: [
    ConversionService,
    AccountStateService,
    RiskContextBuilder,
    RiskLimitsService,
    OrdersService,
    PositionsService,
    TriggerEngineService,
    SnapshotService,
    TradingThrottle,
    ExternalExecutionService,
    VenueRecoveryService,
  ],
  exports: [
    AccountStateService,
    OrdersService,
    PositionsService,
    ConversionService,
    TriggerEngineService,
    SnapshotService,
    VenueRecoveryService,
  ],
})
export class TradingModule {}
