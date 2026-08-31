import { createSign } from 'node:crypto';

/**
 * A Google service account's OAuth 2.0 access token.
 *
 * FCM's HTTP v1 API takes an OAuth bearer token, not the legacy server key. The
 * flow is the documented JWT-bearer grant:
 *
 *   1. build a JWT claiming `iss` (the service account), `scope`, `aud` (the
 *      token endpoint), `iat` and `exp`;
 *   2. sign it RS256 with the account's private key;
 *   3. POST it to the token endpoint as `assertion` with
 *      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`;
 *   4. receive `{ access_token, expires_in }`.
 *
 * Reference: developers.google.com/identity/protocols/oauth2/service-account
 *
 * Written out rather than pulled in as `google-auth-library` because it is
 * forty lines, because this process should not gain a transitive dependency
 * tree for one HTTP call, and because a reviewer can check these forty lines
 * against the specification in a way they cannot check a package version.
 */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly projectId: string;
}

/**
 * Reads a service-account JSON blob.
 *
 * Throws with the missing field named. A push provider that starts with
 * half-parsed credentials fails later, per message, with an authentication
 * error that says nothing about the configuration.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not an object');
  }
  const record = parsed as Record<string, unknown>;

  const read = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`FCM_SERVICE_ACCOUNT_JSON is missing "${key}"`);
    }
    return value;
  };

  return {
    clientEmail: read('client_email'),
    // Environment variables cannot carry real newlines through every deployment
    // path, so the key is commonly stored with them escaped. Restoring them is
    // required for the PEM to parse and costs nothing when they are already real.
    privateKey: read('private_key').replace(/\\n/g, '\n'),
    projectId: read('project_id'),
  };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** Builds and signs the assertion. Exported so a test can inspect it. */
export function buildAssertion(account: ServiceAccount, now: Date, scope = FCM_SCOPE): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.clientEmail,
    scope,
    aud: GOOGLE_TOKEN_ENDPOINT,
    // One hour is the documented maximum. Asking for more is rejected outright.
    exp: issuedAt + 3600,
    iat: issuedAt,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(account.privateKey, 'base64url')}`;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * Fetches and caches the access token.
 *
 * Cached because a market event pushes to thousands of devices in a second and
 * a token exchange per message would both be slow and earn a rate limit from
 * Google's token endpoint. Refreshed a minute early so a token never expires
 * mid-flight — the failure that produces is a 401 on a margin call.
 */
export class GoogleAccessTokens {
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(): Promise<string> {
    const cached = this.cached;
    if (cached !== null && cached.expiresAtMs > this.now().getTime()) return cached.token;

    /**
     * One exchange at a time.
     *
     * Without this, the first push after an expiry starts one token request per
     * concurrent message. Under a market-wide alert that is thousands of
     * identical requests, which is exactly how a service gets its token
     * endpoint rate-limited at the moment it most needs a token.
     */
    this.inFlight ??= this.exchange().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async exchange(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(this.account, this.now()),
    });

    const response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      // The body can contain the assertion we sent back to us. Only the status
      // is logged upstream; nothing here reaches a log by itself.
      throw new Error(`Google refused the service-account assertion: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    const token = payload.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Google returned no access_token');
    }
    const lifetime = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;

    this.cached = {
      token,
      expiresAtMs: this.now().getTime() + Math.max(0, lifetime - 60) * 1000,
    };
    return token;
  }
}
