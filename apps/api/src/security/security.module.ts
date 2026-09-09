import { Global, Module } from '@nestjs/common';
import { SecurityEventsService } from './security-events.service';
import { BreakGlassService } from './break-glass.service';
import { AdminSecurityController } from './admin-security.controller';
import { SecurityController } from './security.controller';
import { BreakGlassController } from './break-glass.controller';
import { IpRulesService } from './ip-rules.service';
import { IpRulesController } from './ip-rules.controller';

/**
 * Global, because the authentication guard resolves break-glass grants and the
 * guard is registered application-wide. A guard that had to be told about a
 * module import would be a guard somebody could leave out of one.
 */
@Global()
@Module({
  controllers: [
    SecurityController,
    AdminSecurityController,
    BreakGlassController,
    IpRulesController,
  ],
  providers: [SecurityEventsService, BreakGlassService, IpRulesService],
  exports: [SecurityEventsService, BreakGlassService, IpRulesService],
})
export class SecurityModule {}
