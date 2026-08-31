import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { AuthService, type LoginResult } from '../../src/auth/auth.service';
import { InvitesService } from '../../src/auth/invites.service';
import { TotpService } from '../../src/auth/totp.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { TokenService } from '../../src/auth/token.service';
import { PasswordService } from '../../src/auth/password.service';
import { EmailPort } from '../../src/auth/email/email.port';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/** Captures messages instead of sending them, so tests can read the token out. */
class CapturingEmailAdapter extends EmailPort {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(message: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(message);
  }
  tokenFrom(pattern: RegExp): string {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const match = pattern.exec(this.sent[i]?.text ?? '');
      if (match?.[1] !== undefined) return match[1];
    }
    throw new Error(`No message matching ${pattern} was sent`);
  }
}

/**
 * Unwraps a login that is expected to have completed.
 *
 * Not a cast: it asserts. A test that expected tokens and got a two-factor
 * challenge has found something worth failing over, and silently reading
 * `undefined` off the wrong branch of the union would hide it.
 */
function authenticated(result: LoginResult) {
  if (result.kind !== 'authenticated') {
    throw new Error(`expected a completed sign-in, got ${result.kind}`);
  }
  return result.pair;
}

const PASSWORD = 'a-sufficiently-long-passphrase';

suite('Auth (integration)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let tokens: TokenService;
  let totp: TotpService;
  let email: CapturingEmailAdapter;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    email = new CapturingEmailAdapter();

    /**
     * Services are wired by hand rather than through Nest's testing module.
     *
     * Vitest transforms TypeScript with esbuild, which does not emit
     * `emitDecoratorMetadata`, so Nest's container cannot see constructor
     * parameter types and every injection resolves to undefined. Explicit
     * construction sidesteps that entirely, and makes each test's dependencies
     * visible at the point of use.
     */
    const config = new ConfigService<Record<string, unknown>, true>({
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
    } as any);

    const prismaService = prisma as unknown as PrismaService;
    const passwords = new PasswordService();
    tokens = new TokenService(new JwtService({}), config as any, prismaService);
    const ledger = new LedgerService();
    const access = new AccountAccessService(prismaService);
    const accounts = new AccountsService(prismaService, access, ledger, config as any);
    const audit = new AuditService(prismaService);
    const secrets = new SecretBox(
      parseEncryptionKeys(config.get('SECRET_ENCRYPTION_KEYS') as string),
    ) as any;
    totp = new TotpService(prismaService, secrets, passwords, audit, config as any);
    const sessions = new SessionsService(prismaService, audit, email);
    auth = new AuthService(
      prismaService,
      passwords,
      tokens,
      totp,
      sessions,
      accounts,
      audit,
      email,
      new InvitesService(prismaService, audit, config as any),
      config as any,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    email.sent.length = 0;
  });

  const register = (overrides: Partial<{ email: string; password: string }> = {}) =>
    auth.register({
      email: overrides.email ?? 'trader@test.local',
      password: overrides.password ?? PASSWORD,
      displayName: 'Test Trader',
    });

  describe('registration', () => {
    it('creates the user, the demo account and its opening ledger entry atomically', async () => {
      const { userId } = await register();

      const accounts = await prisma.account.findMany({ where: { userId } });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.balance.toString()).toBe('100000');
      expect(accounts[0]?.number.startsWith('TP-')).toBe(true);

      const entries = await prisma.balanceLedger.findMany({
        where: { accountId: accounts[0]?.id },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.type).toBe('DEPOSIT');
      expect(entries[0]?.balanceAfter.toString()).toBe('100000');
    });

    it('never stores the password in plaintext', async () => {
      const { userId } = await register();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('does not reveal that an address is already registered', async () => {
      await register();
      // Same shape of success, and no second user row.
      await expect(register()).resolves.toBeDefined();
      expect(await prisma.user.count()).toBe(1);
    });

    it('writes an audit record without the password', async () => {
      await register();
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'USER_REGISTERED' } });
      expect(JSON.stringify(log.after)).not.toContain(PASSWORD);
    });
  });

  describe('login', () => {
    it('issues a usable token pair', async () => {
      await register();
      const pair = authenticated(await auth.login('trader@test.local', PASSWORD));
      const claims = await tokens.verifyAccessToken(pair.accessToken);
      expect(claims.email).toBe('trader@test.local');
      expect(claims.typ).toBe('access');
    });

    it('gives the same error for a wrong password and an unknown address', async () => {
      await register();
      const wrongPassword = await auth
        .login('trader@test.local', 'not-the-password')
        .catch((e) => e);
      const unknownUser = await auth.login('nobody@test.local', PASSWORD).catch((e) => e);
      expect(wrongPassword.message).toBe(unknownUser.message);
      expect(wrongPassword.code).toBe(unknownUser.code);
    });

    it('locks the account after the configured number of failures', async () => {
      await register();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await auth.login('trader@test.local', 'wrong').catch(() => undefined);
      }
      // Even the correct password is refused while the lock holds.
      await expect(auth.login('trader@test.local', PASSWORD)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });

    it('clears the failure count after a successful sign-in', async () => {
      await register();
      await auth.login('trader@test.local', 'wrong').catch(() => undefined);
      await auth.login('trader@test.local', PASSWORD);
      const user = await prisma.user.findFirstOrThrow();
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });

    it('refuses a disabled account', async () => {
      const { userId } = await register();
      await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
      await expect(auth.login('trader@test.local', PASSWORD)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and retires the old token', async () => {
      await register();
      const first = authenticated(await auth.login('trader@test.local', PASSWORD));
      const second = await auth.refresh(first.refreshToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);

      const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.revokedAt).not.toBeNull();
      expect(rows[0]?.replacedBy).toBe(rows[1]?.id);
      expect(rows[0]?.familyId).toBe(rows[1]?.familyId);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      await register();
      const first = authenticated(await auth.login('trader@test.local', PASSWORD));
      const second = await auth.refresh(first.refreshToken);

      await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });

      // The legitimate current token dies too. That is the intended outcome:
      // one of the two holders is a thief and we cannot tell which.
      await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
      expect(live).toBe(0);
    });

    it('keeps separate logins in separate families', async () => {
      await register();
      const sessionA = authenticated(await auth.login('trader@test.local', PASSWORD));
      const sessionB = authenticated(await auth.login('trader@test.local', PASSWORD));

      await auth.refresh(sessionA.refreshToken);
      await expect(auth.refresh(sessionA.refreshToken)).rejects.toThrow();

      // Revoking session A must not sign the user out of session B.
      await expect(auth.refresh(sessionB.refreshToken)).resolves.toBeDefined();
    });

    it('rejects an access token presented as a refresh token', async () => {
      await register();
      const pair = authenticated(await auth.login('trader@test.local', PASSWORD));
      await expect(auth.refresh(pair.accessToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });
  });

  describe('email verification', () => {
    it('verifies with the emailed token and consumes it', async () => {
      const { userId } = await register();
      const token = email.tokenFrom(/verify-email\?token=([\w-]+)/);

      await auth.verifyEmail(token);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.emailVerified).toBe(true);
      expect(user.emailVerificationTokenHash).toBeNull();

      await expect(auth.verifyEmail(token)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('stores only a hash of the token', async () => {
      const { userId } = await register();
      const token = email.tokenFrom(/verify-email\?token=([\w-]+)/);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.emailVerificationTokenHash).not.toBe(token);
    });

    it('rejects an expired token', async () => {
      const { userId } = await register();
      const token = email.tokenFrom(/verify-email\?token=([\w-]+)/);
      await prisma.user.update({
        where: { id: userId },
        data: { emailVerificationExpiresAt: new Date(Date.now() - 1000) },
      });
      await expect(auth.verifyEmail(token)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('password reset', () => {
    it('resets the password and revokes every existing session', async () => {
      await register();
      const session = authenticated(await auth.login('trader@test.local', PASSWORD));

      await auth.requestPasswordReset('trader@test.local');
      const token = email.tokenFrom(/reset-password\?token=([\w-]+)/);
      await auth.resetPassword(token, 'an-entirely-different-passphrase');

      await expect(auth.refresh(session.refreshToken)).rejects.toThrow();
      await expect(auth.login('trader@test.local', PASSWORD)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(
        auth.login('trader@test.local', 'an-entirely-different-passphrase'),
      ).resolves.toBeDefined();
    });

    it('sends nothing and reveals nothing for an unknown address', async () => {
      await expect(auth.requestPasswordReset('nobody@test.local')).resolves.toBeUndefined();
      expect(email.sent).toHaveLength(0);
    });

    it('clears an account lock, so a locked-out user can recover', async () => {
      const { userId } = await register();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await auth.login('trader@test.local', 'wrong').catch(() => undefined);
      }
      await auth.requestPasswordReset('trader@test.local');
      await auth.resetPassword(
        email.tokenFrom(/reset-password\?token=([\w-]+)/),
        'an-entirely-different-passphrase',
      );
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.lockedUntil).toBeNull();
      expect(user.failedLoginAttempts).toBe(0);
    });
  });

  describe('change password', () => {
    it('requires the current password and revokes other sessions', async () => {
      const { userId } = await register();
      const session = authenticated(await auth.login('trader@test.local', PASSWORD));

      await expect(
        auth.changePassword(userId, 'wrong', 'another-long-passphrase'),
      ).rejects.toThrow();
      await auth.changePassword(userId, PASSWORD, 'another-long-passphrase');

      await expect(auth.refresh(session.refreshToken)).rejects.toThrow();
      await expect(
        auth.login('trader@test.local', 'another-long-passphrase'),
      ).resolves.toBeDefined();
    });
  });
});
