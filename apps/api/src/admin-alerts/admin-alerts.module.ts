import { Module } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertRulesService } from './admin-alerts.service';

@Module({
  controllers: [AdminAlertsController],
  providers: [AdminAlertRulesService],
})
export class AdminAlertsModule {}
