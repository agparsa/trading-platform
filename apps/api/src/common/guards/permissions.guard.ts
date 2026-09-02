import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type Permission, TradingErrorCode } from '@tp/shared-types';
import { currentTenant } from '@tp/tenancy';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { RequestWithContext } from '../request-context';
import { RolesService } from '../../permissions/roles.service';
import { CredentialsService } from '../../credentials/credentials.service';

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
 * ## Sessions and credentials
 *
 * A session's capabilities are its role's, served from `RolesService`'s
 * per-tenant cache — grants are rows, and a database read on every request
 * would not be acceptable and does not happen.
 *
 * A credential's capabilities are the set the auth guard attached: the key's
 * subset, already intersected with the holder's current role, or the token's.
 * And a credential may reach **only routes that declare a capability**. A
 * route that declares nothing is a person's — a profile, a notification
 * list, a preference — and a key holding `positions.read` has no business
 * reading its holder's inbox. Refusing there is what makes "per-key
 * permissions" a statement about the key rather than about the routes that
 * happened to be decorated.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const user = request.user;
    const declared = required !== undefined && required.length > 0;

    if (user === undefined) {
      // A public route declares nothing and is allowed; a private one never
      // reaches here without a principal, because the auth guard runs first.
      if (!declared) return true;
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Authentication required');
    }

    if (user.principal !== 'session') {
      if (!declared) {
        this.countRefusal(request);
        throw new DomainError(
          TradingErrorCode.FORBIDDEN,
          'This route is for a signed-in person; a key or token may use only routes that name a capability',
        );
      }
      const held = user.permissions ?? new Set<string>();
      const missing = required.filter((permission) => !held.has(permission));
      if (missing.length > 0) {
        this.countRefusal(request);
        throw new DomainError(
          TradingErrorCode.FORBIDDEN,
          `This operation needs ${missing.join(', ')}, which this credential does not carry`,
          { missing: missing.join(',') },
        );
      }
      return true;
    }

    if (!declared) return true;
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

  private countRefusal(request: RequestWithContext): void {
    const user = request.user;
    const tenant = currentTenant();
    if (user === undefined || user.credentialId === undefined || tenant === undefined) return;
    if (user.principal === 'session') return;
    this.credentials.noteRefusal(user.principal, user.credentialId, tenant);
  }
}
