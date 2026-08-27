import { Module } from '@nestjs/common';
import { MasterAccountsController } from './master-accounts.controller';
import { MasterAccountsService } from './master-accounts.service';

@Module({
  controllers: [MasterAccountsController],
  providers: [MasterAccountsService],
  exports: [MasterAccountsService],
})
export class MasterModule {}
