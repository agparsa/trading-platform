import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithContext } from '../request-context';
import type { UserRole } from '@tp/shared-types';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

/**
 * Injects the authenticated user attached by `JwtAuthGuard`.
 *
 * Throws rather than returning undefined on a public route: silently handing a
 * handler `undefined` where it expects a user is how authorisation checks get
 * skipped by accident.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithContext>();
  if (request.user === undefined) {
    throw new Error('@CurrentUser() used on a route that is not authenticated');
  }
  return request.user;
});
