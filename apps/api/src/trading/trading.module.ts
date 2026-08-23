import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { MarketModule } from '../market/market.module';
import { ConversionService } from '../market/conversion.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import { PositionsService } from './positions.service';
import { RiskContextBuilder } from './risk-context.builder';
import { TradingController } from './trading.controller';

@Module({
  imports: [MarketModule, AccountsModule],
  controllers: [TradingController],
  providers: [
    ConversionService,
    AccountStateService,
    RiskContextBuilder,
    OrdersService,
    PositionsService,
  ],
  exports: [AccountStateService, OrdersService, PositionsService, ConversionService],
})
export class TradingModule {}
