import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { looksLikeCredential } from '@tp/crypto-core';
import {
  DomainError,
  Permission,
  roleHasPermissions,
  TradingErrorCode,
  type UserRole,
} from '@tp/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';
import { SESSION_ONLY_KEY } from '../decorators/session-only.decorator';
import { TokenService } from '../../auth/token.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BreakGlassService } from '../../security/break-glass.service';
import { noteActor } from '../request-scope';
import { clientAddress, type RequestWithContext } from '../request-context';
import { currentTenant } from '@tp/tenancy';

/**
 * Global authentication guard.
 *
 * Registered application-wide, so every route is private unless it opts out with
 * `@Public()`. Forgetting the decorator makes an endpoint inaccessible rather
 * than unprotected — the failure mode that does not lose money.
 *
 * Three things may sit after `Bearer`:
 *
 *   - a **session's access token**, a JWT — the ordinary case, a person at a
 *     screen;
 *   - an **API key**, `tpk_…` — a person's script, acting as them within a
 *     subset of their capabilities;
 *   - a **service token**, `tps_…` — the firm's integration, reading.
 *
 * The prefix decides which, before anything is looked up. Keys and tokens are
 * refused outright on routes marked `@SessionOnly()` or `@SelfService()`: the
 * places credentials are made, and the places a person changes what
 * authenticates them, are for the person.
 *
 * The user row is re-read on every request, whichever kind. A token minted
 * fifteen minutes ago cannot prove the account is still active, and a
 * suspended trader must stop trading immediately, not when their access token
 * happens to expire.
 */
/**
 * Whether a request carrying a break-glass grant may proceed, and if not, why.
 *
 * The three refusals, as one pure decision, so they can be tested where they
 * are made. They used to live inline in two branches of `canActivate` — one of
 * them reachable only with a real token, a real credential and a real request
 * object — which is why they were, until September 2026, defended by exactly
 * one probe that could not fail. Removing the read-only rule from a compiled
 * build left all sixty-two penetration attacks passing.
 *
 * Returns `null` when there is nothing to refuse: no grant presented, or a
 * person with the permission making a read.
 *
 * The order matters. The method is checked **before** anything that depends on
 * the grant existing, so a caller cannot learn whether a grant id is real from
 * which refusal they get.
 */
export function breakGlassRefusal(request: {
  readonly grantId: string;
  readonly method: string;
  readonly principal: string;
  readonly role: UserRole;
}): string | null {
  if (request.grantId.trim() === '') return null;

  if (request.principal !== 'session') {
    return 'A break-glass grant belongs to a person, not to a key or a service token';
  }
  if (!roleHasPermissions(request.role, [Permission.SECURITY_BREAK_GLASS])) {
    return 'You may not open a break-glass session';
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return 'A break-glass session may look and may not touch';
  }
  return null;
}

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
    @Inject(BreakGlassService) private readonly breakGlass: BreakGlassService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const header = request.header('authorization');
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Authentication required');
    }
    const bearer = header.slice('Bearer '.length).trim();

    /**
     * The tenant must be the one this hostname serves.
     *
     * The middleware has already put a tenant in scope from the hostname; a
     * session token carries the tenant it was minted for, and a credential is
     * looked up inside the scope so one from another tenant is not found. If
     * they disagree, the bearer was issued somewhere else — either an attack,
     * or a deployment where one firm's hostname is answering with another's
     * certificate. Neither is a request to serve.
     *
     * Answered as "invalid" rather than "wrong tenant": telling a caller that
     * their bearer is valid *somewhere* is telling them where to try next.
     */
    const tenant = currentTenant();
    if (tenant === undefined) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }

    if (looksLikeCredential(bearer)) {
      const sessionOnly =
        this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, targets) === true ||
        this.reflector.getAllAndOverride<boolean>(SELF_SERVICE_KEY, targets) === true;
      if (sessionOnly) {
        throw new DomainError(
          TradingErrorCode.FORBIDDEN,
          'This needs a signed-in session, not an API key or service token',
        );
      }
      const principal = await this.credentials.authenticate(bearer, tenant, clientAddress(request));
      request.user =
        principal.kind === 'api_key'
          ? {
              id: principal.user.id,
              email: principal.user.email,
              role: principal.user.role,
              sessionId: `key:${principal.credentialId}`,
              principal: 'api_key',
              credentialId: principal.credentialId,
              permissions: principal.permissions,
            }
          : {
              id: principal.credentialId,
              email: `${principal.fingerprint}@service`,
              role: 'SERVICE',
              sessionId: `token:${principal.credentialId}`,
              principal: 'service_token',
              credentialId: principal.credentialId,
              permissions: principal.permissions,
            };
      noteActor(request.user.id);
      /**
       * A credential presenting a grant is **told**, not quietly served its own
       * view.
       *
       * The refusal below used to be an omission: this branch returned before
       * `attachBreakGlass` ran, so `x-break-glass` on an API key was silently
       * ignored and the caller got a 200 full of the key's own data. Safe — no
       * escalation — and wrong in the way this guard already argues against two
       * bullets further down: *a caller who cannot use a grant needs to be
       * told, not quietly served their own view while they believe they are
       * seeing somebody else's.* Whoever sent that header was acting on a
       * belief about whose data they were reading.
       *
       * `docs/break-glass.md` listed it under "The refusals" the whole time.
       * The document was right and the code was not.
       */
      const credentialRefusal = breakGlassRefusal({
        grantId: request.header('x-break-glass')?.trim() ?? '',
        method: request.method,
        principal: request.user.principal ?? 'credential',
        role: request.user.role as UserRole,
      });
      if (credentialRefusal !== null) {
        throw new DomainError(TradingErrorCode.FORBIDDEN, credentialRefusal, {
          principal: request.user.principal,
        });
      }
      return true;
    }

    const claims = await this.tokens.verifyAccessToken(bearer);
    if (claims.tid !== tenant.tenantId) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (user === null || !user.isActive) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
    }

    request.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      sessionId: claims.fam,
      principal: 'session',
    };
    noteActor(request.user.id);

    await this.attachBreakGlass(request, user.role);
    return true;
  }

  /**
   * A break-glass grant, if this request presented one (§9).
   *
   * Opt-in **per request**, by header, and that is the point: a staff member
   * browsing normally cannot accidentally be looking at somebody else's data,
   * because looking at somebody else's data takes an explicit act on every
   * single request.
   *
   * Three refusals happen here rather than in the service:
   *
   *   1. **No permission, no grant.** Presenting one without
   *      `security.break_glass` is refused outright rather than ignored — a
   *      caller who has had the permission taken away needs to be told, not
   *      quietly served their own view while they believe they are seeing
   *      somebody else's.
   *   2. **Reads only.** Every non-GET request carrying a grant is refused,
   *      whatever the grant says. This is the one check that makes "read-only
   *      by default" a property of the system rather than a hope about which
   *      routes were remembered.
   *   3. **Sessions only.** A grant on an API key or service token is refused
   *      before this point — the credential path returns above and never gets
   *      here. A long-lived secret must not be able to read a trader's private
   *      view.
   *
   * A grant that is expired, ended, or somebody else's resolves to nothing and
   * the request proceeds as the staff member. That degradation is deliberate:
   * a stale grant id in a browser tab should show the operator their own screen,
   * not a wall of errors.
   */
  private async attachBreakGlass(
    request: RequestWithContext,
    role: UserRole,
  ): Promise<void> {
    const grantId = request.header('x-break-glass')?.trim();
    if (grantId === undefined || grantId === '') return;

    const refusal = breakGlassRefusal({
      grantId,
      method: request.method,
      principal: 'session',
      role,
    });
    if (refusal !== null) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, refusal, { method: request.method });
    }

    const grant = await this.breakGlass.resolve(request.user!.id, grantId);
    if (grant === null) return;

    request.user = {
      ...request.user!,
      viewingAs: {
        grantId: grant.id,
        userId: grant.subjectUserId,
        email: grant.subjectEmail,
        expiresAt: grant.expiresAt,
      },
    };
  }
}
