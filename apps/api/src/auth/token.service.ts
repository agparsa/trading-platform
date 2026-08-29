import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DomainError, TradingErrorCode, type UserRole } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import type {
  AccessTokenClaims,
  RefreshTokenClaims,
  TokenPair,
  TwoFactorChallengeClaims,
} from './token.types';

export interface IssueContext {
  readonly userAgent?: string;
  readonly ipAddress?: string;
}

/**
 * Issues, verifies and rotates tokens.
 *
 * Refresh tokens are stored as SHA-256 hashes. SHA-256 rather than Argon2 is
 * correct here and only here: the token is 256 bits of cryptographic randomness,
 * so there is no low-entropy secret to slow an attacker down — and refresh
 * happens often enough that a memory-hard hash would be a self-inflicted
 * denial of service.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issuePair(
    user: { id: string; email: string; role: UserRole },
    context: IssueContext = {},
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const accessClaims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      role: user.role,
      typ: 'access',
    };
    const accessToken = await this.jwt.signAsync(accessClaims, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });

    const tokenId = randomUUID();
    // The random component makes the token unguessable even if the JWT secret
    // ever leaks; the database row is still required for it to be accepted.
    const secret = randomBytes(32).toString('base64url');
    const refreshClaims: RefreshTokenClaims = {
      sub: user.id,
      fam: familyId,
      jti: tokenId,
      typ: 'refresh',
    };
    const refreshJwt = await this.jwt.signAsync(refreshClaims, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
    });
    const refreshToken = `${refreshJwt}.${secret}`;

    await this.prisma.refreshToken.create({
      data: {
        id: tokenId,
        userId: user.id,
        familyId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: this.refreshExpiry(),
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds(),
    };
  }

  /**
   * Issues the short-lived proof that a password was accepted.
   *
   * Nothing about it is stored. It is not a session — it grants only the right
   * to be asked for a code — and a row per abandoned login attempt would be a
   * table that grows with every mistyped code and is never read.
   */
  async issueTwoFactorChallenge(
    userId: string,
  ): Promise<{ challengeToken: string; expiresIn: number }> {
    const claims: TwoFactorChallengeClaims = { sub: userId, typ: '2fa' };
    const challengeToken = await this.jwt.signAsync(claims, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('TWO_FACTOR_CHALLENGE_TTL', { infer: true }),
    });
    return {
      challengeToken,
      expiresIn: parseDuration(this.config.get('TWO_FACTOR_CHALLENGE_TTL', { infer: true })),
    };
  }

  async verifyTwoFactorChallenge(token: string): Promise<TwoFactorChallengeClaims> {
    let claims: TwoFactorChallengeClaims;
    try {
      claims = await this.jwt.verifyAsync<TwoFactorChallengeClaims>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new DomainError(
        TradingErrorCode.UNAUTHENTICATED,
        expired
          ? 'This sign-in attempt has expired. Enter your password again.'
          : 'Invalid sign-in challenge',
      );
    }
    // An access token must not stand in for a challenge any more than the
    // reverse: the whole point of the discriminator is that it cuts both ways.
    if (claims.typ !== '2fa') {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Token is not a sign-in challenge');
    }
    return claims;
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new DomainError(
        expired ? TradingErrorCode.TOKEN_EXPIRED : TradingErrorCode.UNAUTHENTICATED,
        expired ? 'Access token has expired' : 'Invalid access token',
      );
    }
    // A refresh token signed with a leaked access secret must still be useless
    // as an access token.
    if (claims.typ !== 'access') {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Token is not an access token');
    }
    return claims;
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been rotated or revoked means it was
   * captured: the whole family is revoked, logging out both the thief and the
   * legitimate user. That is the intended outcome — the alternative leaves an
   * attacker with a valid session.
   */
  async rotate(presentedToken: string, context: IssueContext = {}): Promise<TokenPair> {
    const jwtPart = presentedToken.split('.').slice(0, 3).join('.');
    let claims: RefreshTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshTokenClaims>(jwtPart, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    }
    if (claims.typ !== 'refresh') {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Token is not a refresh token');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(presentedToken) },
      include: { user: true },
    });

    if (stored === null) {
      // Correctly signed but unknown to us: either forged with a leaked secret,
      // or belonging to a family we already revoked. Revoke again, defensively.
      await this.revokeFamily(claims.fam);
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Refresh token is not recognised');
    }

    if (stored.revokedAt !== null || stored.replacedBy !== null) {
      await this.revokeFamily(stored.familyId);
      throw new DomainError(
        TradingErrorCode.UNAUTHENTICATED,
        'Refresh token has already been used. All sessions for this login have been revoked.',
      );
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(TradingErrorCode.TOKEN_EXPIRED, 'Refresh token has expired');
    }

    if (!stored.user.isActive) {
      await this.revokeFamily(stored.familyId);
      throw new DomainError(TradingErrorCode.FORBIDDEN, 'This account is disabled');
    }

    const pair = await this.issuePair(
      { id: stored.userId, email: stored.user.email, role: stored.user.role },
      context,
      stored.familyId,
    );

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: this.tokenIdOf(pair.refreshToken) },
    });

    return pair;
  }

  async revokeToken(presentedToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(presentedToken) },
    });
    if (stored === null) return; // Already gone; logout is idempotent.
    await this.revokeFamily(stored.familyId);
  }

  async revokeFamily(familyId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private tokenIdOf(refreshToken: string): string {
    const payload = this.jwt.decode<RefreshTokenClaims>(
      refreshToken.split('.').slice(0, 3).join('.'),
    );
    return payload.jti;
  }

  private accessTtlSeconds(): number {
    return parseDuration(this.config.get('JWT_ACCESS_TTL', { infer: true }));
  }

  private refreshExpiry(): Date {
    return new Date(
      Date.now() + parseDuration(this.config.get('JWT_REFRESH_TTL', { infer: true })) * 1000,
    );
  }
}

/**
 * Parses the `15m` / `30d` duration strings used for token TTLs.
 * Exported for testing: an off-by-one here silently changes how long sessions live.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Unsupported duration '${value}'. Use a form like 15m, 12h or 30d.`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const seconds = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
  return amount * seconds;
}
