import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountAccessService } from './account-access.service';
import { AccountsService } from './accounts.service';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [AccountsController],
  providers: [AccountAccessService, AccountsService, LedgerService],
  exports: [AccountAccessService, AccountsService, LedgerService],
})
export class AccountsModule {}
