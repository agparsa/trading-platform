import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { GRANTABLE_PERMISSIONS, RolesService, type RoleView } from './roles.service';
import { SetRolePermissionsDto } from './dto/set-role-permissions.dto';

@ApiTags('permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  /**
   * What the caller may do.
   *
   * The terminal uses this to hide controls nobody can use, which is courtesy
   * rather than security — every one of these capabilities is enforced again on
   * the route that needs it. A client that lied to itself about this list would
   * only be surprised by a refusal, never granted anything.
   */
  @Get('me')
  @ApiOperation({ summary: 'The capabilities the authenticated user carries' })
  async me(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ role: string; permissions: string[] }> {
    const held = await this.roles.permissionsFor(user.role);
    return { role: user.role, permissions: [...held].sort() };
  }

  /**
   * Every capability this build defines.
   *
   * The catalogue is code, not data — a capability that exists only as a row is
   * one no route can require — so this endpoint reports what the running build
   * knows rather than what the database holds. An administrator editing a role
   * needs it to know which checkboxes exist.
   */
  @Get('catalogue')
  @RequirePermissions(Permission.ROLES_READ)
  @ApiOperation({ summary: 'Every capability a role could be granted' })
  catalogue(): { permissions: string[] } {
    return { permissions: [...GRANTABLE_PERMISSIONS] };
  }

  @Get('roles')
  @RequirePermissions(Permission.ROLES_READ)
  @ApiOperation({ summary: 'The roles in this tenant and what each carries' })
  async list(): Promise<{ roles: readonly RoleView[] }> {
    return { roles: await this.roles.list() };
  }

  /**
   * Replaces what a role carries.
   *
   * A whole set rather than add/remove, because two administrators editing the
   * same role concurrently should not silently merge into a union nobody chose.
   * The refusals live in `RolesService` so no other caller can reach the write
   * without them.
   */
  @Put('roles/:key')
  @RequirePermissions(Permission.ROLES_MANAGE)
  @ApiOperation({ summary: 'Replace the capabilities a role carries' })
  async setPermissions(
    @Param('key') key: string,
    @Body() body: SetRolePermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleView> {
    return this.roles.setPermissions(key, body.permissions, { id: user.id, role: user.role });
  }
}
