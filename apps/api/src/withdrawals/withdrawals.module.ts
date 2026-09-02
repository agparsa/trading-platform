import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { KycModule } from '../kyc/kyc.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WithdrawalsService } from './withdrawals.service';
import { AdminWithdrawalsService } from './admin-withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';
import { AdminWithdrawalsController } from './admin-withdrawals.controller';

/**
 * Where phases 4, 5 and 6 meet.
 *
 * `WalletModule` because a withdrawal is a wallet movement and the wallet
 * service is the only writer of one; `KycModule` because the gate is a
 * question only it can answer; `NotificationsModule` because a decision is
 * told to the person it is about. Nothing from trading, in either direction.
 */
@Module({
  imports: [WalletModule, KycModule, NotificationsModule],
  controllers: [WithdrawalsController, AdminWithdrawalsController],
  providers: [WithdrawalsService, AdminWithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
