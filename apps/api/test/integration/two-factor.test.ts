import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuthService, type LoginResult } from '../../src/auth/auth.service';
import { InvitesService } from '../../src/auth/invites.service';
import { TotpService } from '../../src/auth/totp.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { TokenService } from '../../src/auth/token.service';
import { EmailPort } from '../../src/auth/email/email.port';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { base32Decode, codeForStep, stepFor } from '../../src/auth/totp';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RolesService } from '../../src/permissions/roles.service';
import { redisStub } from './redis-stub';
import { createTestClient, hasTestDatabase, resetDatabase, testPasswordService } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const PASSWORD = 'a-sufficiently-long-passphrase';
const KEY = generateEncryptionKey('test');

class SilentEmailAdapter extends EmailPort {
  constructor() {
    super('no-reply@test.local');
  }

  async send(): Promise<void> {}
}

/**
 * Two-factor authentication, end to end against a real database.
 *
 * The cases that matter are the ones about what 2FA is *for*: a password alone
 * stops opening the door, a captured code cannot be replayed, and a user who
 * loses their phone can still get in exactly as many times as they have codes.
 */
suite('Two-factor authentication (integration)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let totp: TotpService;
  let secrets: SecretBox;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();

    const config = new ConfigService<Record<string, unknown>, true>({
      JWT_ACCESS_SECRET: 'test_access_secret_at_least_32_characters_long',
      JWT_REFRESH_SECRET: 'test_refresh_secret_at_least_32_characters_long',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '30d',
      TWO_FACTOR_CHALLENGE_TTL: '5m',
      TOTP_ISSUER: 'Trading Platform',
      APP_PUBLIC_URL: 'http://localhost:3000',
      EMAIL_VERIFICATION_TTL_HOURS: 24,
      PASSWORD_RESET_TTL_MINUTES: 60,
      LOGIN_MAX_FAILED_ATTEMPTS: 3,
      LOGIN_LOCKOUT_MINUTES: 15,
      DEFAULT_ACCOUNT_CURRENCY: 'USD',
      DEFAULT_ACCOUNT_LEVERAGE: 100,
      DEMO_ACCOUNT_INITIAL_BALANCE: '100000',
    } as never);

    const prismaService = prisma as unknown as PrismaService;
    const passwords = testPasswordService();
    const tokens = new TokenService(new JwtService({}), config as never, prismaService);
    const access = new AccountAccessService(prismaService);
    const accounts = new AccountsService(
      prismaService,
      access,
      new LedgerService(),
      config as never,
    );
    const audit = new AuditService(prismaService);
    secrets = new SecretBox(parseEncryptionKeys(KEY));
    totp = new TotpService(prismaService, secrets as never, passwords, audit, config as never);
    const sessions = new SessionsService(prismaService, audit, new SilentEmailAdapter());
    auth = new AuthService(
      prismaService,
      passwords,
      tokens,
      totp,
      sessions,
      accounts,
      audit,
      new SilentEmailAdapter(),
      new InvitesService(
        prismaService,
        audit,
        new RolesService(prismaService, redisStub().service, audit),
        config as never,
      ),
      config as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Only `Date` is faked, and it is faked on purpose.
   *
   * Every code is spent when it is used, so any two operations in one 30-second
   * window would collide — which is exactly what a real user experiences and
   * exactly what these tests need to be able to step past. `advanceOneStep()`
   * is the test's way of saying "half a minute later, the phone shows a new
   * code". Faking timers as well would stall Prisma's own internals.
   */
  beforeEach(async () => {
    await resetDatabase(prisma);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-29T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Thirty seconds on: the authenticator app now shows a different code. */
  function advanceOneStep(): void {
    vi.setSystemTime(new Date(Date.now() + 30_000));
  }

  async function registeredUser(email = 'trader@test.local'): Promise<string> {
    const { userId } = await auth.register({ email, password: PASSWORD, displayName: 'Trader' });
    return userId;
  }

  /** The secret as the user's phone would hold it. */
  async function secretOf(userId: string): Promise<Buffer> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return base32Decode(secrets.open(row.totpSecret ?? '', `user:${userId}:totp`));
  }

  const codeNow = (secret: Buffer, atMs = Date.now()) => codeForStep(secret, stepFor(atMs));

  async function enrolled(email = 'trader@test.local') {
    const userId = await registeredUser(email);
    await totp.beginEnrolment(userId);
    const secret = await secretOf(userId);
    const { recoveryCodes } = await totp.activate(userId, codeNow(secret));
    // The code that proved the enrolment is now spent. Move to the next one, as
    // a user who signs in a minute after setting 2FA up would.
    advanceOneStep();
    return { userId, secret, recoveryCodes };
  }

  async function codeOf(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
    throw new Error('the operation succeeded — it should have been refused');
  }

  describe('enrolment', () => {
    it('does not switch anything on until a code has been produced', async () => {
      const userId = await registeredUser();
      const offer = await totp.beginEnrolment(userId);
      expect(offer.otpauthUri).toContain('otpauth://totp/');

      // The secret is stored, but the user can still sign in with a password
      // alone. Somebody who closed the tab has not locked themselves out.
      expect(await totp.status(userId)).toMatchObject({ enabled: false, pending: true });
      const result = await auth.login('trader@test.local', PASSWORD);
      expect(result.kind).toBe('authenticated');
    });

    it('stores the secret sealed, not in plain text', async () => {
      const { userId } = await enrolled();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const plaintext = secrets.open(row.totpSecret ?? '', `user:${userId}:totp`);

      expect(row.totpSecret).not.toBeNull();
      expect(row.totpSecret).not.toContain(plaintext);
      expect(row.totpSecret?.startsWith('v1.test.')).toBe(true);
    });

    /**
     * The sealed value is bound to the row it belongs to. An attacker who can
     * write to the database but cannot read the key must not be able to move
     * their own secret into somebody else's account.
     */
    it('refuses a secret transplanted from another user', async () => {
      const attacker = await enrolled('attacker@test.local');
      const victim = await enrolled('victim@test.local');

      const attackerRow = await prisma.user.findUniqueOrThrow({ where: { id: attacker.userId } });
      await prisma.user.update({
        where: { id: victim.userId },
        data: { totpSecret: attackerRow.totpSecret },
      });

      // The attacker's own app now produces codes for the victim's row, and the
      // server refuses them — with an internal error, deliberately, because
      // nothing about this is the user's code being wrong.
      expect(await codeOf(() => totp.consume(victim.userId, codeNow(attacker.secret)))).toBe(
        TradingErrorCode.INTERNAL_ERROR,
      );
    });

    it('refuses a wrong code and stays off', async () => {
      const userId = await registeredUser();
      await totp.beginEnrolment(userId);

      expect(await codeOf(() => totp.activate(userId, '000000'))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );
      expect((await totp.status(userId)).enabled).toBe(false);
    });

    it('issues ten recovery codes, stored only as hashes', async () => {
      const { userId, recoveryCodes } = await enrolled();
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);

      const stored = await prisma.totpRecoveryCode.findMany({ where: { userId } });
      expect(stored).toHaveLength(10);
      for (const code of recoveryCodes) {
        expect(stored.some((row) => row.codeHash.includes(code))).toBe(false);
      }
      expect((await totp.status(userId)).recoveryCodesRemaining).toBe(10);
    });

    it('refuses to enrol again while it is already on', async () => {
      const { userId } = await enrolled();
      expect(await codeOf(() => totp.beginEnrolment(userId))).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
    });
  });

  describe('sign-in', () => {
    it('stops at a challenge instead of issuing tokens', async () => {
      await enrolled();
      const result = await auth.login('trader@test.local', PASSWORD);

      expect(result.kind).toBe('twoFactorRequired');
      if (result.kind !== 'twoFactorRequired') throw new Error('unreachable');
      expect(result.challengeToken.length).toBeGreaterThan(0);

      // Nothing was issued: no session row exists yet.
      expect(await prisma.refreshToken.count()).toBe(0);
    });

    it('completes with a code from the enrolled device', async () => {
      const { secret } = await enrolled();
      const challenge = await challengeFor();

      const pair = await auth.completeTwoFactor(challenge, codeNow(secret));
      expect(pair.accessToken.length).toBeGreaterThan(0);
      expect(await prisma.refreshToken.count()).toBe(1);
    });

    /**
     * The reason `matchCode` returns a step instead of a boolean. A code lives
     * for thirty seconds — long enough for anyone who saw it to use it.
     */
    it('refuses the same code a second time', async () => {
      const { secret } = await enrolled();
      const code = codeNow(secret);

      // First use succeeds.
      await auth.completeTwoFactor(await challengeFor(), code);

      // Second use of the identical code, still inside its thirty seconds and
      // still arithmetically correct, is refused. This is what stops somebody
      // who watched the code being typed from following the user in.
      const challenge = await challengeFor();
      expect(await codeOf(() => auth.completeTwoFactor(challenge, code))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );
    });

    it('refuses a code from a step already passed, not just the exact one used', async () => {
      const { userId, secret } = await enrolled();
      const now = Date.now();

      await auth.completeTwoFactor(await challengeFor(), codeForStep(secret, stepFor(now)));
      // The previous step is still inside the ±1 window and arithmetically
      // valid. It is refused because time only moves one way.
      const earlier = codeForStep(secret, stepFor(now) - 1);
      expect(await codeOf(async () => auth.completeTwoFactor(await challengeFor(), earlier))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpLastStep).toBe(BigInt(stepFor(now)));
    });

    it('refuses a challenge that is not a challenge', async () => {
      const { secret } = await enrolled();
      // An access token is not a licence to skip the second factor, even though
      // it is signed with the same secret.
      const pair = await auth.completeTwoFactor(await challengeFor(), codeNow(secret));
      expect(await codeOf(() => auth.completeTwoFactor(pair.accessToken, '000000'))).toBe(
        TradingErrorCode.UNAUTHENTICATED,
      );
    });

    it('counts a wrong code towards the lockout, so the second factor is not free to guess', async () => {
      await enrolled();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await auth.completeTwoFactor(await challengeFor(), '000000').catch(() => undefined);
      }
      // The lockout now applies to the password step as well: the account is
      // locked, not merely the code endpoint.
      expect(await codeOf(() => auth.login('trader@test.local', PASSWORD))).toBe(
        TradingErrorCode.RATE_LIMITED,
      );
    });

    it('does not clear the failure counter merely because the password was right', async () => {
      await enrolled();
      await auth.login('trader@test.local', 'wrong').catch(() => undefined);
      await auth.login('trader@test.local', PASSWORD);

      const row = await prisma.user.findFirstOrThrow({ where: { email: 'trader@test.local' } });
      expect(row.failedLoginAttempts).toBe(1);
      // And nobody has signed in, so this is untouched.
      expect(row.lastLoginAt).toBeNull();
    });

    async function challengeFor(email = 'trader@test.local'): Promise<string> {
      const result: LoginResult = await auth.login(email, PASSWORD);
      if (result.kind !== 'twoFactorRequired') throw new Error('expected a challenge');
      return result.challengeToken;
    }
  });

  describe('recovery codes', () => {
    it('lets a user sign in without their phone, once per code', async () => {
      const { recoveryCodes } = await enrolled();
      const result = await auth.login('trader@test.local', PASSWORD);
      if (result.kind !== 'twoFactorRequired') throw new Error('expected a challenge');

      const code = recoveryCodes[0] ?? '';
      const pair = await auth.completeTwoFactor(result.challengeToken, code);
      expect(pair.accessToken.length).toBeGreaterThan(0);

      const again = await auth.login('trader@test.local', PASSWORD);
      if (again.kind !== 'twoFactorRequired') throw new Error('expected a challenge');
      expect(await codeOf(() => auth.completeTwoFactor(again.challengeToken, code))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );
    });

    it('accepts the code the way a person writes it down', async () => {
      const { userId, recoveryCodes } = await enrolled();
      const code = (recoveryCodes[0] ?? '').toLowerCase().replace(/-/g, ' ');
      await expect(totp.consume(userId, code)).resolves.toEqual({ usedRecoveryCode: true });
    });

    it('keeps the used code rather than deleting it, so the event can be answered for', async () => {
      const { userId, recoveryCodes } = await enrolled();
      await totp.consume(userId, recoveryCodes[0] ?? '');

      expect(await prisma.totpRecoveryCode.count({ where: { userId } })).toBe(10);
      expect(await prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } })).toBe(9);
      expect((await totp.status(userId)).recoveryCodesRemaining).toBe(9);

      const audited = await prisma.auditLog.findMany({
        where: { action: 'TWO_FACTOR_RECOVERY_CODE_USED' },
      });
      expect(audited).toHaveLength(1);
    });

    it('invalidates old codes when 2FA is re-enrolled', async () => {
      const { userId, recoveryCodes, secret } = await enrolled();
      await totp.disable(userId, PASSWORD, codeNow(secret));

      await totp.beginEnrolment(userId);
      const fresh = await secretOf(userId);
      advanceOneStep();
      await totp.activate(userId, codeNow(fresh));

      expect(await codeOf(() => totp.consume(userId, recoveryCodes[0] ?? ''))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );
    });
  });

  describe('turning it off', () => {
    it('needs the password and a live code', async () => {
      const { userId, secret } = await enrolled();

      expect(await codeOf(() => totp.disable(userId, 'wrong-password', codeNow(secret)))).toBe(
        TradingErrorCode.UNAUTHENTICATED,
      );
      expect(await codeOf(() => totp.disable(userId, PASSWORD, '000000'))).toBe(
        TradingErrorCode.TWO_FACTOR_INVALID,
      );
      expect((await totp.status(userId)).enabled).toBe(true);

      advanceOneStep();
      await totp.disable(userId, PASSWORD, codeNow(secret));
      expect(await totp.status(userId)).toMatchObject({
        enabled: false,
        pending: false,
        recoveryCodesRemaining: 0,
      });
    });

    it('leaves nothing behind that could still authenticate', async () => {
      const { userId, secret } = await enrolled();
      await totp.disable(userId, PASSWORD, codeNow(secret));

      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.totpSecret).toBeNull();
      expect(row.totpEnabledAt).toBeNull();
      expect(row.totpLastStep).toBeNull();
      expect(await prisma.totpRecoveryCode.count({ where: { userId } })).toBe(0);

      const result = await auth.login('trader@test.local', PASSWORD);
      expect(result.kind).toBe('authenticated');
    });

    it('records both directions in the audit trail', async () => {
      const { userId, secret } = await enrolled();
      await totp.disable(userId, PASSWORD, codeNow(secret));

      const actions = await prisma.auditLog.findMany({
        where: { actorId: userId, action: { startsWith: 'TWO_FACTOR' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(actions.map((row) => row.action)).toEqual([
        'TWO_FACTOR_ENABLED',
        'TWO_FACTOR_DISABLED',
      ]);
    });
  });
});
