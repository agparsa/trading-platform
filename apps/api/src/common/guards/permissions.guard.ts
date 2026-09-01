import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type Permission, TradingErrorCode } from '@tp/shared-types';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { RequestWithContext } from '../request-context';
import { RolesService } from '../../permissions/roles.service';

/**
 * Permission enforcement, in the backend, where it counts.
 *
 * The frontend hides controls a user cannot use; that is courtesy, not security.
 * Anyone can send the request the hidden button would have sent, so the answer
 * has to be decided here.
 *
 * The refusal deliberately names the missing permission. An operator who cannot
 * do something needs to know *which* capability they lack in order to ask for
 * it, and the permission name leaks nothing an authenticated user could not
 * already infer from the route they just called.
 *
 * ## Why this is asynchronous now
 *
 * Grants are rows rather than constants, so the answer comes from
 * `RolesService` — which serves it from a per-tenant cache and reloads only when
 * a grant changes. The route this runs on is every authenticated route, so a
 * database read per request would not be acceptable and does not happen; see
 * that service for the cache and for what it does when the database will not
 * answer.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RolesService) private readonly roles: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const user = request.user;
    if (user === undefined) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Authentication required');
    }

    const held = await this.roles.permissionsFor(user.role);
    const missing = required.filter((permission) => !held.has(permission));
    if (missing.length > 0) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `This operation needs ${missing.join(', ')}, which your role does not carry`,
        { missing: missing.join(',') },
      );
    }
    return true;
  }
}
