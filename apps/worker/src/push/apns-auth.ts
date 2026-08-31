import { createPrivateKey, sign } from 'node:crypto';

/**
 * The APNs provider authentication token.
 *
 * Apple's token-based connection: a JWT signed ES256 with a `.p8` key from the
 * developer account, carried as `authorization: bearer <jwt>`.
 *
 *   header  { "alg": "ES256", "kid": <10-character Key ID> }
 *   claims  { "iss": <10-character Team ID>, "iat": <epoch seconds> }
 *
 * Reference:
 * developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
 *
 * ## The refresh window is a range, not a deadline
 *
 * Apple rejects a token whose `iat` is more than an hour old
 * (`ExpiredProviderToken`) **and** rejects a new token presented more than once
 * every twenty minutes on the same connection
 * (`TooManyProviderTokenUpdates`). Both are errors, in opposite directions, so
 * the refresh interval must sit strictly inside that window. Fifty minutes
 * leaves ten minutes of margin against the hour and is well clear of the
 * twenty-minute floor.
 */
export const APNS_TOKEN_REFRESH_MS = 50 * 60 * 1000;

export interface ApnsCredentials {
  /** 10-character Key ID from the developer account. */
  readonly keyId: string;
  /** 10-character Team ID. */
  readonly teamId: string;
  /** The `.p8` file's contents, PEM-encoded. */
  readonly privateKey: string;
  /** The app's bundle ID; the `apns-topic` header. */
  readonly bundleId: string;
  /** Production goes to api.push.apple.com; anything else to the sandbox. */
  readonly production: boolean;
}

export function parseApnsCredentials(raw: string): ApnsCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('APNS_CREDENTIALS_JSON is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('APNS_CREDENTIALS_JSON is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const read = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`APNS_CREDENTIALS_JSON is missing "${key}"`);
    }
    return value;
  };

  const keyId = read('keyId');
  const teamId = read('teamId');
  // Both are documented as exactly ten characters. Checking here turns a
  // mystifying InvalidProviderToken at 3am into a boot failure that names the
  // field.
  if (keyId.length !== 10)
    throw new Error(`APNs keyId should be 10 characters, got ${keyId.length}`);
  if (teamId.length !== 10) {
    throw new Error(`APNs teamId should be 10 characters, got ${teamId.length}`);
  }

  return {
    keyId,
    teamId,
    privateKey: read('privateKey').replace(/\\n/g, '\n'),
    bundleId: read('bundleId'),
    production: record['production'] === true,
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Signs one provider token.
 *
 * `dsaEncoding: 'ieee-p1363'` is the load-bearing option. Node's default for an
 * EC key is a DER-wrapped signature; JWT requires the raw r‖s concatenation.
 * The DER form is a perfectly valid ECDSA signature that APNs rejects as
 * `InvalidProviderToken`, with no hint that the encoding is the problem.
 */
export function signApnsToken(credentials: ApnsCredentials, now: Date): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: credentials.teamId, iat: Math.floor(now.getTime() / 1000) }),
  );
  const signingInput = `${header}.${claims}`;

  const signature = sign(null, Buffer.from(signingInput), {
    key: createPrivateKey(credentials.privateKey),
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Holds one token and re-signs it inside Apple's window. */
export class ApnsTokens {
  private token: string | null = null;
  private signedAtMs = 0;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): string {
    const nowMs = this.now().getTime();
    if (this.token === null || nowMs - this.signedAtMs >= APNS_TOKEN_REFRESH_MS) {
      this.token = signApnsToken(this.credentials, this.now());
      this.signedAtMs = nowMs;
    }
    return this.token;
  }

  /**
   * Forces a re-sign after an `ExpiredProviderToken`.
   *
   * Only reachable through that error, because signing on demand would walk
   * straight into `TooManyProviderTokenUpdates` — the failure on the other side
   * of the same window.
   */
  invalidate(): void {
    this.token = null;
    this.signedAtMs = 0;
  }
}

export function apnsHost(credentials: ApnsCredentials): string {
  return credentials.production
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}
