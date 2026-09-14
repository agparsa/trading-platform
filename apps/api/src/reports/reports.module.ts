import { Module } from '@nestjs/common';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PermissionsModule],
  controllers: [ReportsController],
  providers: [QueuePublisher, ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
