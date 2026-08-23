import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema, resetPasswordSchema } from './auth.dto';

describe('register schema', () => {
  it('normalises email case and whitespace so one person cannot hold two accounts', () => {
    const parsed = registerSchema.parse({
      email: '  Trader@Example.COM ',
      password: 'a-sufficiently-long-passphrase',
      displayName: ' Parsa ',
    });
    expect(parsed.email).toBe('trader@example.com');
    expect(parsed.displayName).toBe('Parsa');
  });

  it('rejects a short password', () => {
    expect(() =>
      registerSchema.parse({ email: 'a@b.test', password: 'short', displayName: 'A' }),
    ).toThrow();
  });

  it('rejects an absurdly long password, which is a hashing DoS vector', () => {
    expect(() =>
      registerSchema.parse({ email: 'a@b.test', password: 'x'.repeat(500), displayName: 'A' }),
    ).toThrow();
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    expect(() =>
      registerSchema.parse({
        email: 'a@b.test',
        password: 'a-sufficiently-long-passphrase',
        displayName: 'A',
        role: 'ADMIN',
      }),
    ).toThrow();
  });

  it('rejects a malformed email', () => {
    expect(() =>
      registerSchema.parse({
        email: 'not-an-email',
        password: 'a-long-passphrase',
        displayName: 'A',
      }),
    ).toThrow();
  });
});

describe('login schema', () => {
  it('does not impose the minimum length on an existing password', () => {
    // Rejecting a short password at login would tell an attacker the policy
    // changed, and would lock out users whose password predates it.
    expect(() => loginSchema.parse({ email: 'a@b.test', password: 'old' })).not.toThrow();
  });
});

describe('reset schema', () => {
  it('enforces the new-password policy', () => {
    expect(() => resetPasswordSchema.parse({ token: 't', password: 'short' })).toThrow();
    expect(() =>
      resetPasswordSchema.parse({ token: 't', password: 'a-sufficiently-long-passphrase' }),
    ).not.toThrow();
  });
});
