import { describe, expect, it } from 'vitest';
import { updateProfileSchema } from './users.controller';
import { UsersService } from './users.service';

describe('PATCH /users/me — what it accepts', () => {
  it('takes a phone number in international form, without the spaces people type', () => {
    expect(updateProfileSchema.parse({ phone: '+98 912 123-4567' })).toEqual({
      phone: '+989121234567',
    });
    expect(updateProfileSchema.parse({ phone: null })).toEqual({ phone: null });
  });

  it('refuses a number that is not E.164', () => {
    for (const phone of ['09121234567', '+0912123456', '+98abc', '+1234', '+1234567890123456']) {
      expect(updateProfileSchema.safeParse({ phone }).success, phone).toBe(false);
    }
  });

  it('refuses an empty change and fields it does not know', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
    expect(updateProfileSchema.safeParse({ email: 'a@b.c' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ displayName: '  ' }).success).toBe(false);
  });
});

describe('UsersService.updateProfile', () => {
  const row = {
    id: 'u1',
    email: 'a@b.c',
    displayName: 'A',
    phone: null as string | null,
    role: 'USER',
    emailVerified: true,
    createdAt: new Date(0),
    lastLoginAt: null,
    passwordHash: 'never',
    totpSecret: 'never',
  };
  const prisma = {
    user: {
      findUnique: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data),
    },
  };
  const users = new UsersService(prisma as never);

  it('changes only what it is given, and never returns a secret', async () => {
    const after = await users.updateProfile('u1', { phone: '+989121234567' });
    expect(after.phone).toBe('+989121234567');
    expect(after.displayName).toBe('A');
    expect(JSON.stringify(after)).not.toContain('never');
    const cleared = await users.updateProfile('u1', { phone: null });
    expect(cleared.phone).toBeNull();
  });
});
