import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [AccountsController],
  providers: [AccountsService, LedgerService],
  exports: [AccountsService, LedgerService],
})
export class AccountsModule {}
