/**
 * What sign-in, the second-factor step and a refresh answer with — one shape
 * for every client, in the one package every client and the API share.
 *
 * It was three shapes. The API answered `{ accessToken, expiresIn }` and set
 * the refresh token as a cookie; the web read that; the phone was written
 * against `{ accessToken, refreshToken, expiresInSeconds }` and a challenge
 * called `challengeId`, posted it to `/auth/2fa/verify` — a route that has
 * never existed — and stored `refreshToken: undefined` in the keychain, which
 * `expo-secure-store` refuses. No build of the mobile app could sign anybody
 * in; nothing caught it because the app had never been opened. With the type
 * here, a client reading a field the API does not send fails to compile.
 */
export interface AuthTokenResponse {
  readonly accessToken: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  /**
   * Present only for a client that holds its own refresh token — a native app,
   * identified by sending no `Origin` (a browser cannot omit it) together with
   * its installation. A browser gets the token as an httpOnly cookie and never
   * in a body, where an injected script could read it. See
   * `issuesBodyRefreshToken` in the API.
   */
  readonly refreshToken?: string;
}

export interface TwoFactorChallengeResponse {
  readonly twoFactorRequired: true;
  /** Single-use; presented to `POST /auth/login/2fa` with the code. */
  readonly challengeToken: string;
  /** Seconds the challenge stays valid. */
  readonly expiresIn: number;
}

export type SignInResponse = AuthTokenResponse | TwoFactorChallengeResponse;

export function isTwoFactorChallenge(
  response: SignInResponse,
): response is TwoFactorChallengeResponse {
  return (response as { twoFactorRequired?: unknown }).twoFactorRequired === true;
}
