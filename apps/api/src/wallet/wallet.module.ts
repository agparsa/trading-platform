import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { AdminWalletController } from './admin-wallet.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TradingModule } from '../trading/trading.module';

/**
 * `AccountsModule` for the ledger — the only writer of an account's balance —
 * and `TradingModule` for the valuation that says how much of that balance is
 * actually free. Neither is re-implemented here: a second opinion about free
 * margin is a second answer to "may this money leave", and the trader was
 * looking at the first one.
 */
@Module({
  imports: [AccountsModule, TradingModule],
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
