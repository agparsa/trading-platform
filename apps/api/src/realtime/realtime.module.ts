import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { TradingModule } from '../trading/trading.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [MarketModule, TradingModule, AuthModule],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
