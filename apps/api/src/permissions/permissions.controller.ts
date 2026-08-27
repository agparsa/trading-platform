import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { permissionsFor, type UserRole } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('permissions')
@Controller('permissions')
export class PermissionsController {
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
  me(@CurrentUser() user: AuthenticatedUser): { role: string; permissions: string[] } {
    return { role: user.role, permissions: [...permissionsFor(user.role as UserRole)] };
  }
}
