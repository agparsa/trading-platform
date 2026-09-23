import { ApiClient } from '@tp/api-client';
import Constants from 'expo-constants';
import { TokenStore, type Tokens } from './token-store';
import { secureStore } from './secure-store';

/**
 * Where this build talks to.
 *
 * From the Expo config rather than a constant, so a development build can point
 * at a laptop and a store build cannot. A missing value throws at startup:
 * a client that silently falls back to localhost looks like a network problem
 * to everyone who has to debug it.
 */
export function apiBaseUrl(): string {
  const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: unknown } | undefined)
    ?.apiBaseUrl;
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error(
      'expo.extra.apiBaseUrl is not set. Add it to app.json or pass EXPO_PUBLIC_API_URL.',
    );
  }
  return configured;
}

/** Re-exported: the parser lives beside the store, where it can be tested without a device. */
export { toTokens } from './token-store';

/**
 * The one client the app uses.
 *
 * Built once and shared, because `TokenStore` deduplicates concurrent refreshes
 * and a second store would defeat that — two stores means two refreshes, and
 * refresh tokens rotate.
 */
export function createApi(tokens: TokenStore): ApiClient {
  let cached: string | null = null;

  return new ApiClient({
    baseUrl: apiBaseUrl(),
    getAccessToken: () => cached,
    onTokenExpired: async () => {
      const renewed = await tokens.current();
      cached = renewed?.accessToken ?? null;
      return cached;
    },
    /**
     * No cookies.
     *
     * The web client sends `include` so its httpOnly refresh cookie reaches the
     * auth routes. A native app has no cookie jar worth trusting and holds its
     * refresh token in the keychain instead, so sending credentials here would
     * be noise at best.
     */
    credentials: 'omit',
  });
}

export const tokenStore = (refresh: (refreshToken: string) => Promise<Tokens>): TokenStore =>
  new TokenStore(secureStore, refresh);
