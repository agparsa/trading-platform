import { describe, expect, it } from 'vitest';
import express from 'express';
import pinoHttp from 'pino-http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import {
  NOT_SECRET_BODY_FIELDS,
  SECRET_BODY_FIELDS,
  SECRET_NAME_PATTERN,
  SERIALISED_SECRET_PATHS,
  redactionOptions,
  secretBodyPaths,
} from './logging';

/**
 * Distinctive values, so a match in the captured log is the value and not a
 * coincidence of the word appearing in a header name.
 */
const SECRETS = {
  bearer: 'BEARER-9f2c4a',
  cookie: 'COOKIE-71bd30',
  setCookie: 'SETCOOKIE-4e8a11',
  password: 'PASSWORD-c30d72',
  code: 'CODE-0a5b93',
  challengeToken: 'CHALLENGE-6d4f28',
  refreshToken: 'REFRESH-8b1e05',
  token: 'RESET-2c7a64',
  inviteCode: 'INVITE-5f9d31',
  pushToken: 'PUSH-e17c48',
  totpCode: 'TOTP-338a0c',
} as const;

/** A real writable, so the destination is the shape pino is given in production. */
function collect(lines: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
}

/**
 * Runs one request through a real express + pino-http stack and returns
 * everything pino wrote.
 *
 * `redact` is a parameter rather than a constant so the same request can be
 * sent through the configuration and through nothing. A redaction test with no
 * control passes just as well when the value was never logged in the first
 * place — which is exactly the mistake this file was written about.
 */
async function capture(redact: ReturnType<typeof redactionOptions> | null): Promise<string> {
  const lines: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ level: 'info', ...(redact === null ? {} : { redact }) }, collect(lines)));
  app.post('/probe', (_request, response) => {
    response.setHeader('set-cookie', `tp_rt=${SECRETS.setCookie}; HttpOnly`);
    response.status(200).json({ ok: true });
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SECRETS.bearer}`,
        cookie: `tp_rt=${SECRETS.cookie}`,
      },
      body: JSON.stringify({
        password: SECRETS.password,
        currentPassword: SECRETS.password,
        newPassword: SECRETS.password,
        totpCode: SECRETS.totpCode,
        code: SECRETS.code,
        challengeToken: SECRETS.challengeToken,
        refreshToken: SECRETS.refreshToken,
        token: SECRETS.token,
        inviteCode: SECRETS.inviteCode,
        pushToken: SECRETS.pushToken,
      }),
    });
    // pino writes on response finish; the fetch resolves a tick earlier.
    for (let attempt = 0; attempt < 50 && lines.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return lines.join('\n');
  } finally {
    server.close();
  }
}

describe('log redaction', () => {
  it('removes every credential the request carried', async () => {
    const logged = await capture(redactionOptions());
    expect(logged).not.toBe('');
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(logged, `${name} reached the log`).not.toContain(value);
    }
  });

  /**
   * The control. Without it the test above passes on a platform that logs
   * nothing at all, and would go on passing after somebody deleted the whole
   * `redact` block.
   */
  it('logs the header credentials when the configuration is removed, so the rules are doing the work', async () => {
    const logged = await capture(null);
    expect(logged).toContain(SECRETS.bearer);
    expect(logged).toContain(SECRETS.cookie);
    expect(logged).toContain(SECRETS.setCookie);
  });

  /**
   * The actual guarantee, stated as an assertion rather than as a comment.
   *
   * If this ever fails, the body paths have stopped being defence in depth and
   * become load-bearing — which is fine, and is the moment to check that
   * `SECRET_BODY_FIELDS` is complete rather than to delete this test.
   */
  it('does not serialise a request body at all, with or without redaction', async () => {
    const unredacted = await capture(null);
    expect(unredacted).not.toContain('"body"');
    for (const value of Object.values(SECRETS)) {
      if (value === SECRETS.bearer || value === SECRETS.cookie || value === SECRETS.setCookie) {
        continue;
      }
      expect(unredacted, 'a body value was serialised').not.toContain(value);
    }
  });

  it('declares a path for every secret body field, and nothing else', () => {
    expect(secretBodyPaths()).toEqual(SECRET_BODY_FIELDS.map((field) => `req.body.${field}`));
    expect(redactionOptions().paths).toEqual([...SERIALISED_SECRET_PATHS, ...secretBodyPaths()]);
    expect(redactionOptions().remove).toBe(true);
  });

  /**
   * pino throws on a malformed redact path at construction. A path with a typo
   * would otherwise take the whole API down at boot rather than in a test.
   */
  it('gives pino paths it accepts', () => {
    expect(() => pinoHttp({ redact: redactionOptions() }, collect([]))).not.toThrow();
  });

  it('matches every name it claims to protect against the secret-name pattern', () => {
    for (const field of SECRET_BODY_FIELDS) {
      expect(SECRET_NAME_PATTERN.test(field), `${field} is not secret-shaped`).toBe(true);
    }
    for (const [field, reason] of Object.entries(NOT_SECRET_BODY_FIELDS)) {
      expect(SECRET_NAME_PATTERN.test(field), `${field} needs no exemption`).toBe(true);
      expect(reason.length, `${field} has no reason`).toBeGreaterThan(20);
    }
  });

  it('keeps the two lists disjoint', () => {
    for (const field of SECRET_BODY_FIELDS) {
      expect(NOT_SECRET_BODY_FIELDS[field], `${field} is on both lists`).toBeUndefined();
    }
  });
});
