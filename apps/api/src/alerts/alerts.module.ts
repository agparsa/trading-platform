import { Module } from '@nestjs/common';
import { PriceAlertsService } from './price-alerts.service';
import { PriceAlertsRunner } from './price-alerts.runner';
import { PriceAlertsController } from './price-alerts.controller';
import { MarketModule } from '../market/market.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [MarketModule, NotificationsModule],
  providers: [PriceAlertsService, PriceAlertsRunner],
  controllers: [PriceAlertsController],
  exports: [PriceAlertsService],
})
export class AlertsModule {}
