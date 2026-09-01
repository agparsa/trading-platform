import { Global, Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { RolesService } from './roles.service';

/**
 * Global because `PermissionsGuard` is registered with `APP_GUARD` and is
 * therefore resolved from the root injector: a service it depends on has to be
 * reachable from there.
 *
 * `AuditModule`, `RedisModule` and `PrismaModule` are already global, so this
 * imports nothing.
 */
@Global()
@Module({
  controllers: [PermissionsController],
  providers: [RolesService],
  exports: [RolesService],
})
export class PermissionsModule {}
