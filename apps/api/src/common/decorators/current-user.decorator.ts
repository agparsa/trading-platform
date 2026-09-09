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
  /**
   * A live break-glass grant, when this request presented one (§9).
   *
   * The caller is **still themselves** — `id`, `email` and `role` are the staff
   * member's, and every audit row written under this request names them. This
   * only says whose data they are permitted to look at, and only for reads:
   * the guard refuses every non-GET request that carries a grant.
   *
   * Absent on almost every request, and a handler that does not know about it
   * simply serves the staff member's own view — which is the safe default.
   */
  readonly viewingAs?: {
    readonly grantId: string;
    readonly userId: string;
    readonly email: string;
    readonly expiresAt: Date;
  };
}

/**
 * Whose data this request is about.
 *
 * The one helper every self-service read should use in place of `user.id`. A
 * route that forgets it serves the staff member's own view rather than the
 * subject's — wrong, but harmless. A route that reached for `viewingAs.userId`
 * without checking would be the other kind of wrong.
 */
export function subjectOf(user: AuthenticatedUser): string {
  return user.viewingAs?.userId ?? user.id;
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
