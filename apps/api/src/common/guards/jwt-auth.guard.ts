import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestWithContext } from '../request-context';
import { currentTenant } from '@tp/tenancy';

/**
 * Global authentication guard.
 *
 * Registered application-wide, so every route is private unless it opts out with
 * `@Public()`. Forgetting the decorator makes an endpoint inaccessible rather
 * than unprotected — the failure mode that does not lose money.
 *
 * The user row is re-read on every request. A token minted fifteen minutes ago
 * cannot prove the account is still active, and a suspended trader must stop
 * trading immediately, not when their access token happens to expire.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const header = request.header('authorization');
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Authentication required');
    }

    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());

    /**
     * The token's tenant must be the one this hostname serves.
     *
     * The middleware has already put a tenant in scope from the hostname; the
     * token carries the tenant it was minted for. If they disagree, the token
     * was issued somewhere else — either an attack, or a deployment where one
     * firm's hostname is answering with another's certificate. Neither is a
     * request to serve, and neither is a case where guessing which one is right
     * would help.
     *
     * Answered as "invalid token" rather than "wrong tenant": telling a caller
     * that their token is valid *somewhere* is telling them where to try next.
     */
    const tenant = currentTenant();
    if (tenant === undefined || claims.tid !== tenant.tenantId) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (user === null || !user.isActive) {
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
    }

    request.user = { id: user.id, email: user.email, role: user.role, sessionId: claims.fam };
    return true;
  }
}
