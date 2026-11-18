import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { MarketModule } from '../market/market.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TradingModule } from '../trading/trading.module';
import { AdminChallengesController, ChallengesController } from './challenges.controller';
import { ChallengesRunner } from './challenges.runner';
import { ChallengesService } from './challenges.service';

@Module({
  imports: [AccountsModule, MarketModule, TradingModule, NotificationsModule],
  controllers: [ChallengesController, AdminChallengesController],
  providers: [ChallengesService, ChallengesRunner],
  exports: [ChallengesService],
})
export class ChallengesModule {}
