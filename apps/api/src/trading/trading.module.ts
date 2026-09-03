import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { MarketModule } from '../market/market.module';
import { ConversionService } from '../market/conversion.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import { PositionsService } from './positions.service';
import { RiskContextBuilder } from './risk-context.builder';
import { TriggerEngineService } from './trigger-engine.service';
import { TradingController } from './trading.controller';
import { TradingThrottle } from './trading-throttle.service';
import { SnapshotService } from './snapshot.service';

@Module({
  imports: [MarketModule, AccountsModule],
  controllers: [TradingController],
  providers: [
    ConversionService,
    AccountStateService,
    RiskContextBuilder,
    OrdersService,
    PositionsService,
    TriggerEngineService,
    SnapshotService,
    TradingThrottle,
  ],
  exports: [
    AccountStateService,
    OrdersService,
    PositionsService,
    ConversionService,
    TriggerEngineService,
    SnapshotService,
  ],
})
export class TradingModule {}
