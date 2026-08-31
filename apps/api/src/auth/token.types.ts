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
  /**
   * The tenant this token was minted for.
   *
   * Short because it is on every request, and the specification's rule is what
   * it exists to satisfy: tenant identity comes from the authenticated context,
   * never from the request. A signed claim is the only thing on a request that
   * the holder cannot change.
   *
   * The guard checks it against the tenant the hostname resolved to. A token
   * minted for one tenant and presented on another's hostname is either an
   * attack or a misconfiguration, and refusing both is right.
   */
  tid: string;
  email: string;
  role: UserRole;
  /**
   * The rotation family this token belongs to — the same value the refresh
   * token carries, and what the user sees as one "session".
   *
   * It is here so a request can say which session it *is*. Without it, a user
   * looking at their list of sessions has no way to tell which row is the
   * browser they are reading it in, and revoking the wrong one signs them out
   * while leaving the intruder in place.
   */
  fam: string;
  /** Token type discriminator — an access token must never be usable as a refresh token. */
  typ: 'access';
  /**
   * Expiry, in epoch **seconds**, as the JWT standard writes it.
   *
   * Declared because the WebSocket gateway needs it: a socket outlives the
   * token that opened it, and without knowing when that token dies there is no
   * moment at which to stop streaming a trader's private frames.
   */
  exp?: number;
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
