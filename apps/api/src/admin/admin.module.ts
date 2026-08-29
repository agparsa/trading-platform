import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { TradingModule } from '../trading/trading.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdjustmentsService } from './adjustments.service';
import { AuditQueryService } from './audit-query.service';
import { RiskConsoleService } from './risk-console.service';

@Module({
  imports: [AccountsModule, AuthModule, TradingModule],
  controllers: [AdminController],
  providers: [AdminService, AdjustmentsService, AuditQueryService, RiskConsoleService],
  exports: [AdminService, RiskConsoleService, AuditQueryService],
})
export class AdminModule {}
