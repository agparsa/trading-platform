import { createVerify, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APNS_TOKEN_REFRESH_MS,
  ApnsTokens,
  apnsHost,
  parseApnsCredentials,
  signApnsToken,
  type ApnsCredentials,
} from './apns-auth';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const credentials: ApnsCredentials = {
  keyId: 'ABC123DEFG',
  teamId: 'DEF123GHIJ',
  privateKey,
  bundleId: 'ir.devopss.trading',
  production: false,
};

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('the APNs provider token', () => {
  const now = new Date('2026-08-31T12:00:00Z');

  it('claims exactly what Apple documents', () => {
    const [header, claims] = signApnsToken(credentials, now).split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'ES256', kid: credentials.keyId });
    expect(decode(claims)).toEqual({
      iss: credentials.teamId,
      iat: Math.floor(now.getTime() / 1000),
    });
  });

  it('signs in the raw r‖s form JWT requires, not DER', () => {
    const [header, claims, signature] = signApnsToken(credentials, now).split('.') as [
      string,
      string,
      string,
    ];
    const raw = Buffer.from(signature, 'base64url');
    /**
     * A P-256 JOSE signature is exactly 64 bytes: r and s, 32 each.
     *
     * Node's default for an EC key is DER, which is 70-ish bytes and starts
     * 0x30. It is a perfectly valid ECDSA signature that APNs rejects as
     * InvalidProviderToken with no hint that the encoding is the problem — so
     * this length check is the whole point of the test.
     */
    expect(raw.length).toBe(64);

    /**
     * There used to be a third assertion here: that the first byte was not
     * 0x30, DER's SEQUENCE tag. That byte is the top of `r`, which is random,
     * so it failed about one run in 256 — and a flaky test in the gate is worse
     * than no test, because it teaches people to re-run rather than to look.
     *
     * It was also carrying nothing. The length above excludes DER on its own —
     * a P-256 DER signature is 70 to 72 bytes and can never be 64 — and the
     * verification below proves the encoding positively, which is the actual
     * guarantee rather than a proxy for it.
     */
    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    expect(
      verifier.verify({ key: createPublicKey(publicKey), dsaEncoding: 'ieee-p1363' }, raw),
    ).toBe(true);
  });
});

describe('refreshing the token', () => {
  it('reuses one token between refreshes', () => {
    let current = new Date('2026-08-31T12:00:00Z');
    const tokens = new ApnsTokens(credentials, () => current);

    const first = tokens.get();
    current = new Date(current.getTime() + 10 * 60 * 1000);
    // Signing on every send walks into TooManyProviderTokenUpdates, which is a
    // 429 from Apple for being too diligent.
    expect(tokens.get()).toBe(first);
  });

  it("re-signs inside Apple's window, not at its edge", () => {
    // Rejected above one hour old; rejected if renewed more often than every
    // twenty minutes. The interval has to sit strictly inside both.
    expect(APNS_TOKEN_REFRESH_MS).toBeGreaterThan(20 * 60 * 1000);
    expect(APNS_TOKEN_REFRESH_MS).toBeLessThan(60 * 60 * 1000);
  });

  it('re-signs once the interval passes', () => {
    let current = new Date('2026-08-31T12:00:00Z');
    const tokens = new ApnsTokens(credentials, () => current);
    const first = tokens.get();
    current = new Date(current.getTime() + APNS_TOKEN_REFRESH_MS + 1_000);
    expect(tokens.get()).not.toBe(first);
  });

  it('re-signs on demand after Apple says the token is stale', () => {
    let current = new Date('2026-08-31T12:00:00Z');
    const tokens = new ApnsTokens(credentials, () => current);
    const first = tokens.get();
    tokens.invalidate();
    current = new Date(current.getTime() + 1_000);
    expect(tokens.get()).not.toBe(first);
  });
});

describe('reading the credentials', () => {
  const valid = {
    keyId: 'ABC123DEFG',
    teamId: 'DEF123GHIJ',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    bundleId: 'ir.devopss.trading',
    production: true,
  };

  it('names a missing field', () => {
    const { bundleId: _omitted, ...withoutBundle } = valid;
    expect(() => parseApnsCredentials(JSON.stringify(withoutBundle))).toThrow(/bundleId/);
  });

  it('refuses an id of the wrong length', () => {
    // A ten-character check here turns a mystifying InvalidProviderToken at 3am
    // into a boot failure that names the field.
    expect(() => parseApnsCredentials(JSON.stringify({ ...valid, keyId: 'SHORT' }))).toThrow(
      /keyId/,
    );
    expect(() =>
      parseApnsCredentials(JSON.stringify({ ...valid, teamId: 'TOOLONGTEAMID' })),
    ).toThrow(/teamId/);
  });

  it('restores newlines escaped by an environment variable', () => {
    expect(parseApnsCredentials(JSON.stringify(valid)).privateKey).toContain('\n');
  });

  it('sends to the sandbox unless production is explicitly true', () => {
    // The dangerous default is the other way round: a production build talking
    // to the sandbox fails loudly, while a debug build talking to production
    // gets BadDeviceToken on every send.
    expect(
      apnsHost(parseApnsCredentials(JSON.stringify({ ...valid, production: false }))),
    ).toContain('sandbox');
    expect(apnsHost(parseApnsCredentials(JSON.stringify(valid)))).toBe(
      'https://api.push.apple.com',
    );
  });
});
