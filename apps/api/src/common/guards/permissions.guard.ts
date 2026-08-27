import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DomainError,
  type Permission,
  roleHasPermissions,
  TradingErrorCode,
  type UserRole,
} from '@tp/shared-types';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { RequestWithContext } from '../request-context';

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
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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

    if (!roleHasPermissions(user.role as UserRole, required)) {
      const held = new Set(required.filter((p) => roleHasPermissions(user.role as UserRole, [p])));
      const missing = required.filter((p) => !held.has(p));
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `This operation needs ${missing.join(', ')}, which your role does not carry`,
        { missing: missing.join(',') },
      );
    }
    return true;
  }
}
