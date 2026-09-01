import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AdminPaymentsService } from './admin-payments.service';
import { PaymentProviders } from './payment-providers';
import { PaymentsController } from './payments.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { PaymentWebhooksController } from './webhooks.controller';
import { WalletModule } from '../wallet/wallet.module';

/**
 * `WalletModule` because a successful payment credits a wallet, and the wallet
 * service is the only writer of one. Payments do not touch trading accounts at
 * all: money arrives in a wallet, and the person decides which account to put it
 * in — which is a separate act with its own record.
 */
@Module({
  imports: [WalletModule],
  controllers: [PaymentsController, AdminPaymentsController, PaymentWebhooksController],
  providers: [PaymentsService, AdminPaymentsService, PaymentProviders],
  exports: [PaymentsService],
})
export class PaymentsModule {}
