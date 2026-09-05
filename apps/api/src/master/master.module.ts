import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { TradingModule } from '../trading/trading.module';
import { MasterAccountsController } from './master-accounts.controller';
import { MasterAccountsService } from './master-accounts.service';
import { DeskViewService } from './desk-view.service';

/**
 * `TradingModule` for `AccountStateService` — the one place equity is
 * computed. A desk total that recomputed it would be a second definition of
 * what an account is worth, and two definitions of equity is the disagreement
 * nobody can settle afterwards.
 */
@Module({
  imports: [TradingModule, MarketModule],
  controllers: [MasterAccountsController],
  providers: [MasterAccountsService, DeskViewService],
  exports: [MasterAccountsService, DeskViewService],
})
export class MasterModule {}
