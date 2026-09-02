import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithContext } from '../request-context';
import type { UserRole } from '@tp/shared-types';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  /** `SERVICE` for a service token, which is nobody's role; see RequestPrincipal. */
  readonly role: UserRole | 'SERVICE';
  /**
   * The session this request belongs to, taken from the token rather than the
   * database — it identifies which of the user's sessions is speaking, which no
   * amount of looking at the user row can tell you. For a credential it names
   * the credential instead.
   */
  readonly sessionId: string;
  /** How the caller authenticated. A handler that cares reads this; most need not. */
  readonly principal: 'session' | 'api_key' | 'service_token';
  readonly credentialId?: string;
}

/**
 * Injects the authenticated principal attached by `BearerAuthGuard`.
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
