import type { UserRole } from '@tp/shared-types';

/**
 * Access-token claims.
 *
 * Deliberately minimal. Anything that can change — account status, balances,
 * permissions beyond the coarse role — is read from the database per request,
 * because a token issued fifteen minutes ago cannot be trusted to describe the
 * present.
 */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  email: string;
  role: UserRole;
  /** Token type discriminator — an access token must never be usable as a refresh token. */
  typ: 'access';
}

export interface RefreshTokenClaims {
  sub: string;
  /** Rotation family. Presenting a rotated token revokes the whole family. */
  fam: string;
  /** Identifies the stored token row so it can be checked against the database. */
  jti: string;
  typ: 'refresh';
}

/**
 * The short-lived proof that a password was accepted and a second factor is
 * still owed.
 *
 * Signed with the access secret and carrying its own `typ`, so
 * `verifyAccessToken` rejects it — a challenge must never be usable as a
 * session. It is a bearer token for one thing only: the right to be asked for a
 * code. Holding one without the code achieves nothing.
 */
export interface TwoFactorChallengeClaims {
  sub: string;
  typ: '2fa';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
