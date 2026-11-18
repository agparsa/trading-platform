import { describe, expect, it } from 'vitest';
import { verify } from '@node-rs/argon2';
import { ALPHABET, LENGTH, generatePassword, parseArgs, setPassword } from './set-password';

describe('a password set from the host', () => {
  it('is generated, long, and free of look-alike characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(LENGTH);
      expect([...password].every((c) => ALPHABET.includes(c))).toBe(true);
      expect(password).not.toMatch(/[0O1lI]/);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });

  it('reads its arguments and refuses what it cannot use', () => {
    expect(parseArgs(['--email', ' A@B.C ', '--reason', 'owner locked out'], {})).toEqual({
      email: 'a@b.c',
      reason: 'owner locked out',
      tenantSlug: 'default',
    });
    expect(() => parseArgs(['--email', 'a@b.c'], {})).toThrow(/reason/);
    expect(() => parseArgs(['--reason', 'owner locked out'], {})).toThrow(/email/);
    expect(() => parseArgs(['--password', 'x'], {})).toThrow(/Unknown/);
  });

  it('stores only an Argon2id hash, ends sessions, and audits without the password', async () => {
    const writes: Record<string, unknown> = {};
    const tx = {
      user: { update: async (args: unknown) => void (writes['user'] = args) },
      refreshToken: { updateMany: async () => ({ count: 3 }) },
      auditLog: { create: async (args: unknown) => void (writes['audit'] = args) },
    };
    const prisma = {
      tenant: { findUnique: async () => ({ id: 't1' }) },
      user: { findUnique: async () => ({ id: 'u1', isActive: true }) },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const password = generatePassword();
    const outcome = await setPassword(
      prisma as never,
      { email: 'a@b.c', reason: 'owner locked out', tenantSlug: 'default' },
      password,
      { memoryCost: 19_456, timeCost: 2 },
      { host: 'h', user: 'root' },
    );
    expect(outcome).toEqual({ userId: 'u1', sessionsEnded: 3 });
    const data = (writes['user'] as { data: { passwordHash: string } }).data;
    expect(data.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(data.passwordHash, password)).toBe(true);
    expect(JSON.stringify(writes)).not.toContain(password);
  });

  it('refuses someone who is not registered', async () => {
    const prisma = {
      tenant: { findUnique: async () => ({ id: 't1' }) },
      user: { findUnique: async () => null },
    };
    await expect(
      setPassword(
        prisma as never,
        { email: 'x@y.z', reason: 'owner locked out', tenantSlug: 'default' },
        'p',
        { memoryCost: 19_456, timeCost: 2 },
      ),
    ).rejects.toThrow(/never created from a host/);
  });
});
