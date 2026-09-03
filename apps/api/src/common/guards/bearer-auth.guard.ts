import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { looksLikeCredential } from '@tp/crypto-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';
import { SESSION_ONLY_KEY } from '../decorators/session-only.decorator';
import { TokenService } from '../../auth/token.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { noteActor } from '../request-scope';
import type { RequestWithContext } from '../request-context';
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
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
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
      const principal = await this.credentials.authenticate(bearer, tenant, request.ip);
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
    return true;
  }
}
