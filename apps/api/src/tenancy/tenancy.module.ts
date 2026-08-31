import { Global, Module } from '@nestjs/common';
import { TenantResolver } from './tenant-resolver.service';

/**
 * Global because the resolver is needed by middleware, by the auth guard and by
 * the realtime gateway, and threading it through every module that touches a
 * request would be noise around something every request has.
 */
@Global()
@Module({
  providers: [TenantResolver],
  exports: [TenantResolver],
})
export class TenancyModule {}
