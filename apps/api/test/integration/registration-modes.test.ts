import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuthService } from '../../src/auth/auth.service';
import { InvitesService } from '../../src/auth/invites.service';
import { TotpService } from '../../src/auth/totp.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { TokenService } from '../../src/auth/token.service';
import { PasswordService } from '../../src/auth/password.service';
import { EmailPort } from '../../src/auth/email/email.port';
import {
  SecretBox,
  generateEncryptionKey,
  parseEncryptionKeys,
} from '../../src/common/crypto/secret-box';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestClient, hasTestDatabase, resetDatabase, DEFAULT_TENANT_ID } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

class SilentEmail extends EmailPort {
  async send(): Promise<void> {}
}

const PASSWORD = 'a-sufficiently-long-passphrase';

function baseConfig(mode: 'open' | 'invite' | 'closed') {
  return {
    JWT_ACCESS_SECRET: 'test_access_secret_at_least_32_characters_long',
    JWT_REFRESH_SECRET: 'test_refresh_secret_at_least_32_characters_long',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    APP_PUBLIC_URL: 'http://localhost:3000',
    EMAIL_VERIFICATION_TTL_HOURS: 24,
    PASSWORD_RESET_TTL_MINUTES: 60,
    LOGIN_MAX_FAILED_ATTEMPTS: 3,
    LOGIN_LOCKOUT_MINUTES: 15,
    DEFAULT_ACCOUNT_CURRENCY: 'USD',
    DEFAULT_ACCOUNT_LEVERAGE: 100,
    DEMO_ACCOUNT_INITIAL_BALANCE: '100000',
    SECRET_ENCRYPTION_KEYS: generateEncryptionKey('test'),
    TOTP_ISSUER: 'Trading Platform',
    TWO_FACTOR_CHALLENGE_TTL: '5m',
    REGISTRATION_MODE: mode,
    INVITE_CODE_TTL_HOURS: 168,
  };
}

suite('Registration modes (integration)', () => {
  let prisma: PrismaClient;
  let adminId: string;

  /** A fresh AuthService/InvitesService pair for one registration mode. */
  function wire(mode: 'open' | 'invite' | 'closed') {
    const config = new ConfigService<Record<string, unknown>, true>(baseConfig(mode) as never);
    const prismaService = prisma as unknown as PrismaService;
    const passwords = new PasswordService();
    const audit = new AuditService(prismaService);
    const tokens = new TokenService(new JwtService({}), config as never, prismaService);
    const secrets = new SecretBox(
      parseEncryptionKeys(config.get('SECRET_ENCRYPTION_KEYS') as string),
    ) as never;
    const accounts = new AccountsService(
      prismaService,
      new AccountAccessService(prismaService),
      new LedgerService(),
      config as never,
    );
    const invites = new InvitesService(prismaService, audit, config as never);
    const auth = new AuthService(
      prismaService,
      passwords,
      tokens,
      new TotpService(prismaService, secrets, passwords, audit, config as never),
      new SessionsService(prismaService, audit, new SilentEmail()),
      accounts,
      audit,
      new SilentEmail(),
      invites,
      config as never,
    );
    return { auth, invites };
  }

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const admin = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'admin@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Admin',
        role: 'ADMIN',
      },
    });
    adminId = admin.id;
  });

  describe('closed', () => {
    it('refuses everyone, including an address nobody has used', async () => {
      const { auth } = wire('closed');
      await expect(
        auth.register({ email: 'nobody@test.local', password: PASSWORD, displayName: 'N' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
      expect(await prisma.user.count({ where: { email: 'nobody@test.local' } })).toBe(0);
    });

    it('refuses before it looks the address up, so it cannot leak who is registered', async () => {
      /**
       * The refusal for an address that already exists must be identical to the
       * refusal for one that does not. Otherwise a closed platform becomes a
       * free membership oracle for anyone with a list of email addresses.
       */
      const { auth } = wire('closed');
      const known = auth
        .register({ email: 'admin@test.local', password: PASSWORD, displayName: 'A' })
        .catch((error: DomainError) => error);
      const unknown = auth
        .register({ email: 'stranger@test.local', password: PASSWORD, displayName: 'S' })
        .catch((error: DomainError) => error);
      const [a, b] = await Promise.all([known, unknown]);
      expect((a as DomainError).code).toBe((b as DomainError).code);
      expect((a as DomainError).message).toBe((b as DomainError).message);
    });
  });

  describe('invite', () => {
    it('refuses a registration with no code at all', async () => {
      const { auth } = wire('invite');
      await expect(
        auth.register({ email: 'a@test.local', password: PASSWORD, displayName: 'A' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect(await prisma.user.count({ where: { email: 'a@test.local' } })).toBe(0);
    });

    it('refuses a code that was never minted', async () => {
      const { auth } = wire('invite');
      await expect(
        auth.register({
          email: 'a@test.local',
          password: PASSWORD,
          displayName: 'A',
          inviteCode: 'AAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('admits the holder of a valid code and records who came in on it', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, { label: 'first tester' });

      const { userId } = await auth.register({
        email: 'invited@test.local',
        password: PASSWORD,
        displayName: 'Invited',
        inviteCode: minted.code,
      });

      const redemption = await prisma.inviteRedemption.findFirstOrThrow({ where: { userId } });
      expect(redemption.inviteCodeId).toBe(minted.id);
      const code = await prisma.inviteCode.findUniqueOrThrow({ where: { id: minted.id } });
      expect(code.useCount).toBe(1);
    });

    it('accepts a code retyped with dashes and in lower case', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      const asTyped = `${minted.code.slice(0, 8)}-${minted.code.slice(8)}`.toLowerCase();

      await expect(
        auth.register({
          email: 'retyped@test.local',
          password: PASSWORD,
          displayName: 'R',
          inviteCode: asTyped,
        }),
      ).resolves.toMatchObject({ userId: expect.any(String) });
    });

    it('will not let one code open two accounts', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      await auth.register({
        email: 'first@test.local',
        password: PASSWORD,
        displayName: 'First',
        inviteCode: minted.code,
      });
      await expect(
        auth.register({
          email: 'second@test.local',
          password: PASSWORD,
          displayName: 'Second',
          inviteCode: minted.code,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect(await prisma.user.count({ where: { email: 'second@test.local' } })).toBe(0);
    });

    it('lets a multi-use code open exactly as many accounts as it says', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, { maxUses: 3 });
      for (const n of [1, 2, 3]) {
        await auth.register({
          email: `bulk${n}@test.local`,
          password: PASSWORD,
          displayName: `B${n}`,
          inviteCode: minted.code,
        });
      }
      await expect(
        auth.register({
          email: 'bulk4@test.local',
          password: PASSWORD,
          displayName: 'B4',
          inviteCode: minted.code,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('survives two people redeeming a single-use code at the same instant', async () => {
      /**
       * The claim is `UPDATE ... WHERE use_count < max_uses RETURNING id`, one
       * statement. Reading the count, deciding, then writing it back would let
       * both of these through — which is how a single-use invitation quietly
       * becomes a two-use one under load.
       */
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});

      const results = await Promise.allSettled([
        auth.register({
          email: 'race-a@test.local',
          password: PASSWORD,
          displayName: 'A',
          inviteCode: minted.code,
        }),
        auth.register({
          email: 'race-b@test.local',
          password: PASSWORD,
          displayName: 'B',
          inviteCode: minted.code,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.inviteRedemption.count()).toBe(1);
      const code = await prisma.inviteCode.findUniqueOrThrow({ where: { id: minted.id } });
      expect(code.useCount).toBe(1);
    });

    it('refuses an expired code', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      await prisma.inviteCode.update({
        where: { id: minted.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await expect(
        auth.register({
          email: 'late@test.local',
          password: PASSWORD,
          displayName: 'L',
          inviteCode: minted.code,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('refuses a revoked code', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      await invites.revoke(adminId, minted.id);
      await expect(
        auth.register({
          email: 'revoked@test.local',
          password: PASSWORD,
          displayName: 'R',
          inviteCode: minted.code,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('says the same thing however a code failed', async () => {
      /**
       * Wrong, expired, revoked and spent all answer identically. A different
       * message for "expired" tells an outsider the code was real, which turns
       * the registration endpoint into a way to test guesses.
       */
      const { auth, invites } = wire('invite');
      const expired = await invites.mint(adminId, {});
      await prisma.inviteCode.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const revoked = await invites.mint(adminId, {});
      await invites.revoke(adminId, revoked.id);

      const messages = await Promise.all(
        [expired.code, revoked.code, 'ZZZZZZZZZZZZZZZZZZZZZZZZ'].map((inviteCode, index) =>
          auth
            .register({
              email: `probe${index}@test.local`,
              password: PASSWORD,
              displayName: 'P',
              inviteCode,
            })
            .then(() => 'accepted')
            .catch((error: DomainError) => error.message),
        ),
      );
      expect(new Set(messages).size).toBe(1);
    });

    it('does not store the code, only its hash and a fingerprint', async () => {
      const { invites } = wire('invite');
      const minted = await invites.mint(adminId, { label: 'never stored' });
      const row = await prisma.inviteCode.findUniqueOrThrow({ where: { id: minted.id } });

      expect(row.codeHash).not.toContain(minted.code);
      expect(row.fingerprint).toBe(minted.code.slice(0, 8));
      // The fingerprint identifies the invitation and cannot redeem it.
      expect(row.fingerprint.length).toBeLessThan(minted.code.length);

      const everyStoredValue = JSON.stringify(row);
      expect(everyStoredValue).not.toContain(minted.code);
    });

    it('never returns the code again, not even to the administrator who minted it', async () => {
      const { invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      const listed = await invites.list();
      expect(JSON.stringify(listed)).not.toContain(minted.code);
      // Nor the hash: a hash in a list is a hash in a log is a hash in a ticket.
      expect(JSON.stringify(listed)).not.toContain('codeHash');
    });

    it('keeps the code out of the audit trail, keeping the fingerprint', async () => {
      const { auth, invites } = wire('invite');
      const minted = await invites.mint(adminId, {});
      await auth.register({
        email: 'audited@test.local',
        password: PASSWORD,
        displayName: 'A',
        inviteCode: minted.code,
      });

      const entries = await prisma.auditLog.findMany({
        where: { action: { in: ['INVITE_CODE_CREATED', 'USER_REGISTERED'] } },
      });
      const serialised = JSON.stringify(entries);
      expect(serialised).not.toContain(minted.code);
      expect(serialised).toContain(minted.fingerprint);
    });
  });

  describe('open', () => {
    it('admits anyone, and ignores an invite code offered anyway', async () => {
      const { auth } = wire('open');
      const { userId } = await auth.register({
        email: 'walkin@test.local',
        password: PASSWORD,
        displayName: 'W',
        inviteCode: 'IRRELEVANT',
      });
      expect(await prisma.inviteRedemption.count({ where: { userId } })).toBe(0);
    });

    it('records the mode it was running in, so a registration can be explained later', async () => {
      const { auth } = wire('open');
      const { userId } = await auth.register({
        email: 'explained@test.local',
        password: PASSWORD,
        displayName: 'E',
      });
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'USER_REGISTERED', resourceId: userId },
      });
      expect(entry.after).toMatchObject({ registrationMode: 'open' });
    });
  });
});
