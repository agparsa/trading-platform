import { Module } from '@nestjs/common';
import { SecurityEventsService } from './security-events.service';
import { AdminSecurityController } from './admin-security.controller';
import { SecurityController } from './security.controller';

@Module({
  controllers: [SecurityController, AdminSecurityController],
  providers: [SecurityEventsService],
  exports: [SecurityEventsService],
})
export class SecurityModule {}
