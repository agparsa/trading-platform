import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, TradingErrorCode, type UserRole } from '@tp/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { RequestWithContext } from '../request-context';

/**
 * Role check.
 *
 * Membership is explicit, not hierarchical: an ADMIN is not implicitly a
 * SUPPORT. Ranking roles invites the assumption that a higher role can do
 * everything a lower one can, which stops being true the moment a role exists
 * to *restrict* someone.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const user = request.user;
    if (user === undefined) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Authentication required');
    }
    if (!required.includes(user.role as UserRole)) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'Your role does not permit this operation');
    }
    return true;
  }
}
