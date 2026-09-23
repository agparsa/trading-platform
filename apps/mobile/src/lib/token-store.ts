import type { AuthTokenResponse } from '@tp/shared-types';

/**
 * The access and refresh tokens, and the rule for renewing them.
 *
 * ## Why the storage is behind a port
 *
 * So this file can be tested. `expo-secure-store` needs a device; the decision
 * about *when* to refresh, and what happens when two screens ask at once, does
 * not — and that decision is where the bugs are.
 *
 * ## Why the mobile client holds a refresh token at all
 *
 * The web client keeps it in an httpOnly cookie the JavaScript cannot read,
 * which is strictly better. A native app has no such thing: the operating
 * system's keychain is the equivalent, and that is what `SecureStorePort` is
 * expected to wrap. It must never be `AsyncStorage`, which is a plaintext file
 * readable by anything with access to the app's sandbox.
 */
export interface SecureStorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly accessTokenExpiresAt: number;
}

const ACCESS_KEY = 'tp.access';
const REFRESH_KEY = 'tp.refresh';
const EXPIRY_KEY = 'tp.access.expiry';

/**
 * Renew this long before the access token actually expires.
 *
 * A token that expires mid-request produces a 401 on whatever the trader was
 * doing, and the one they are most likely to be doing is closing a position.
 * Thirty seconds is comfortably longer than any request this app makes.
 */
export const REFRESH_MARGIN_MS = 30_000;

export class TokenStore {
  private cached: Tokens | null = null;
  private refreshing: Promise<Tokens | null> | null = null;

  constructor(
    private readonly storage: SecureStorePort,
    private readonly refresh: (refreshToken: string) => Promise<Tokens>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<Tokens | null> {
    if (this.cached !== null) return this.cached;

    const [accessToken, refreshToken, expiry] = await Promise.all([
      this.storage.get(ACCESS_KEY),
      this.storage.get(REFRESH_KEY),
      this.storage.get(EXPIRY_KEY),
    ]);
    if (accessToken === null || refreshToken === null) return null;

    const accessTokenExpiresAt = Number(expiry);
    this.cached = {
      accessToken,
      refreshToken,
      // A missing or corrupt expiry is treated as "expired", not as "forever".
      // The cost is one extra refresh; the alternative is a client that keeps
      // presenting a dead token and cannot say why it is being refused.
      accessTokenExpiresAt: Number.isFinite(accessTokenExpiresAt) ? accessTokenExpiresAt : 0,
    };
    return this.cached;
  }

  async save(tokens: Tokens): Promise<void> {
    this.cached = tokens;
    await Promise.all([
      this.storage.set(ACCESS_KEY, tokens.accessToken),
      this.storage.set(REFRESH_KEY, tokens.refreshToken),
      this.storage.set(EXPIRY_KEY, String(tokens.accessTokenExpiresAt)),
    ]);
  }

  async clear(): Promise<void> {
    this.cached = null;
    this.refreshing = null;
    await Promise.all([
      this.storage.remove(ACCESS_KEY),
      this.storage.remove(REFRESH_KEY),
      this.storage.remove(EXPIRY_KEY),
    ]);
  }

  /**
   * A token good for the next request, refreshing first if it is close to
   * expiry.
   *
   * ## One refresh at a time
   *
   * A dashboard mounts and fires five requests at once. Without the in-flight
   * promise, all five would see a stale token and start five refreshes — and
   * since refresh tokens rotate, four of them would present a token the server
   * has already invalidated, which reads as replay and logs the trader out.
   * This is the single most important line in the file.
   */
  async current(): Promise<Tokens | null> {
    const tokens = await this.load();
    if (tokens === null) return null;

    if (tokens.accessTokenExpiresAt - this.now() > REFRESH_MARGIN_MS) return tokens;

    this.refreshing ??= this.doRefresh(tokens.refreshToken).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(refreshToken: string): Promise<Tokens | null> {
    try {
      const renewed = await this.refresh(refreshToken);
      await this.save(renewed);
      return renewed;
    } catch {
      // A refresh that fails means the session is over — revoked, expired, or
      // signed out elsewhere. Clearing is what makes the app show the login
      // screen instead of retrying forever against a token that will never work.
      await this.clear();
      return null;
    }
  }
}

/**
 * Reads the token pair out of a sign-in, second-factor or refresh response.
 *
 * Typed by the API's own contract (`AuthTokenResponse` in `@tp/shared-types`).
 * It was typed by a guess — `refreshToken` and `expiresInSeconds` — and the API
 * sends `expiresIn`, and a refresh token only to a client that identifies itself
 * as native. So every sign-in on the phone stored `undefined` in the keychain,
 * which `expo-secure-store` refuses, and the app could not sign anybody in.
 *
 * A response with no refresh token is refused here, by name, rather than
 * stored: it means the request did not identify itself as a native client (no
 * installation, or an `Origin` header), and a session that cannot be renewed
 * would end silently fifteen minutes later.
 */
export function toTokens(payload: AuthTokenResponse, now: number = Date.now()): Tokens {
  if (typeof payload.refreshToken !== 'string' || payload.refreshToken === '') {
    throw new Error(
      'The server did not return a refresh token. The request must carry the installation and no Origin header.',
    );
  }
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: now + payload.expiresIn * 1_000,
  };
}
