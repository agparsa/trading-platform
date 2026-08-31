import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FCM_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleAccessTokens,
  buildAssertion,
  parseServiceAccount,
  type ServiceAccount,
} from './google-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const account: ServiceAccount = {
  clientEmail: 'push@example.iam.gserviceaccount.com',
  privateKey,
  projectId: 'example-project',
};

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/**
 * The assertion Google will accept, or will not.
 *
 * Every field here is checked against the documented flow rather than against
 * what happened to work: a wrong `aud` or an `exp` more than an hour out is
 * rejected with `invalid_grant`, which says nothing about which field was
 * wrong, and the only symptom in production is that push stops.
 */
describe('the service-account assertion', () => {
  const now = new Date('2026-08-31T12:00:00Z');

  it('claims what the flow requires', () => {
    const [header, claims] = buildAssertion(account, now).split('.') as [string, string, string];

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const body = decode(claims);
    expect(body['iss']).toBe(account.clientEmail);
    expect(body['scope']).toBe(FCM_SCOPE);
    // Not the FCM endpoint: the audience of the assertion is the token
    // endpoint, and getting this wrong is the commonest mistake in this flow.
    expect(body['aud']).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(body['iat']).toBe(Math.floor(now.getTime() / 1000));
  });

  it('asks for no more than the documented maximum hour', () => {
    const claims = decode(buildAssertion(account, now).split('.')[1]!);
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBeLessThanOrEqual(3600);
  });

  it('is actually signed by the key', () => {
    const assertion = buildAssertion(account, now);
    const [header, claims, signature] = assertion.split('.') as [string, string, string];

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('reading the service account', () => {
  it('names the field that is missing', () => {
    expect(() => parseServiceAccount(JSON.stringify({ project_id: 'x' }))).toThrow(/client_email/);
  });

  it('rejects something that is not JSON', () => {
    expect(() => parseServiceAccount('not json')).toThrow(/valid JSON/);
  });

  it('restores newlines escaped by an environment variable', () => {
    // A PEM that travelled through an env var usually has \n as two characters.
    // Left as-is, the key does not parse and every push fails at signing.
    const raw = JSON.stringify({
      client_email: 'a@b.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      project_id: 'p',
    });
    expect(parseServiceAccount(raw).privateKey).toContain('\n');
    expect(parseServiceAccount(raw).privateKey).not.toContain('\\n');
  });
});

describe('the access token cache', () => {
  const tokenResponse = (token: string, expiresIn = 3600) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('posts the documented grant', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-1'));
    const tokens = new GoogleAccessTokens(account, fetchImpl as unknown as typeof fetch);

    expect(await tokens.get()).toBe('token-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('reuses a token rather than exchanging per message', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-1'));
    const tokens = new GoogleAccessTokens(account, fetchImpl as unknown as typeof fetch);

    await tokens.get();
    await tokens.get();
    await tokens.get();
    // A market-wide alert pushes to thousands of devices in a second. One
    // exchange per message would be slow and would earn a rate limit from the
    // token endpoint at the moment a token is most needed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exchanges once when many callers arrive at the same moment', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const tokens = new GoogleAccessTokens(account, fetchImpl as unknown as typeof fetch);

    const all = Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    resolveFetch(tokenResponse('token-1'));
    expect(await all).toEqual(['token-1', 'token-1', 'token-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes early, so a token never expires mid-flight', async () => {
    let current = new Date('2026-08-31T12:00:00Z');
    let issued = 0;
    const fetchImpl = vi.fn(async () => tokenResponse(`token-${++issued}`, 120));
    const tokens = new GoogleAccessTokens(
      account,
      fetchImpl as unknown as typeof fetch,
      () => current,
    );

    expect(await tokens.get()).toBe('token-1');
    // 70 seconds later: the token has 50 seconds of life left, which is inside
    // the one-minute safety margin. The failure this avoids is a 401 on a
    // margin call.
    current = new Date(current.getTime() + 70_000);
    expect(await tokens.get()).toBe('token-2');
  });

  it('refuses a response with no token rather than sending an empty bearer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 }),
    );
    const tokens = new GoogleAccessTokens(account, fetchImpl as unknown as typeof fetch);
    await expect(tokens.get()).rejects.toThrow(/no access_token/);
  });

  it('does not put the assertion in the error message', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('the assertion you sent was bad', { status: 400 }),
    );
    const tokens = new GoogleAccessTokens(account, fetchImpl as unknown as typeof fetch);
    // The response body can echo the signed assertion back. It is a credential
    // for one hour; it must not reach a log through an exception message.
    await expect(tokens.get()).rejects.toThrow(/HTTP 400/);
    await expect(tokens.get()).rejects.not.toThrow(/assertion you sent/);
  });
});
