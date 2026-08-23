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

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
