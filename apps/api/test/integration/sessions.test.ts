import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuthService, type LoginResult } from '../../src/auth/auth.service';
import { InvitesService } from '../../src/auth/invites.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { TotpService } from '../../src/auth/totp.service';
import { TokenService } from '../../src/auth/token.service';
import { PasswordService } from '../../src/auth/password.service';
import { EmailPort, type EmailMessage } from '../../src/auth/email/email.port';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const PASSWORD = 'a-sufficiently-long-passphrase';
const EMAIL = 'trader@test.local';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';
const CHROME_MAC_OLDER = CHROME_MAC.replace('131.0.0.0', '120.0.0.0');

class CapturingEmailAdapter extends EmailPort {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Sessions, devices and the notice a user gets when something new signs in.
 *
 * The point of the whole feature is one question a person is trying to answer:
 * *is one of these not me?* Every case below is about whether the answer they
 * are given is usable.
 */
suite('Sessions and device visibility (integration)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let sessions: SessionsService;
  let tokens: TokenService;
  let email: CapturingEmailAdapter;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    email = new CapturingEmailAdapter();

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
    const passwords = new PasswordService();
    tokens = new TokenService(new JwtService({}), config as never, prismaService);
    const audit = new AuditService(prismaService);
    const secrets = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
    const totp = new TotpService(
      prismaService,
      secrets as never,
      passwords,
      audit,
      config as never,
    );
    sessions = new SessionsService(prismaService, audit, email);
    auth = new AuthService(
      prismaService,
      passwords,
      tokens,
      totp,
      sessions,
      new AccountsService(
        prismaService,
        new AccountAccessService(prismaService),
        new LedgerService(),
        config as never,
      ),
      audit,
      email,
      new InvitesService(prismaService, audit, config as never),
      config as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    email.sent.length = 0;
    await auth.register({ email: EMAIL, password: PASSWORD, displayName: 'Trader' });
    email.sent.length = 0;
  });

  async function signIn(userAgent: string, ipAddress = '203.0.113.4') {
    const result: LoginResult = await auth.login(EMAIL, PASSWORD, { userAgent, ipAddress });
    if (result.kind !== 'authenticated') throw new Error('expected a completed sign-in');
    return result.pair;
  }

  const userId = async () => (await prisma.user.findFirstOrThrow({ where: { email: EMAIL } })).id;

  describe('the list', () => {
    /**
     * The regression that shaped `list`. Rotation revokes the row it replaces,
     * so a query for live rows returns only the newest token of each family —
     * and a list built from those alone tells a user who has been signed in
     * since Monday that they signed in fifteen minutes ago. That is exactly the
     * fact they opened the list to check.
     */
    it('reports when a session began, not when it last refreshed', async () => {
      const pair = await signIn(CHROME_MAC);
      let current = pair.refreshToken;
      for (let i = 0; i < 3; i += 1) {
        current = (await tokens.rotate(current, { userAgent: CHROME_MAC })).refreshToken;
      }

      const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
      const [entry] = await sessions.list(await userId());
      expect(entry?.signedInAt).toBe(rows[0]?.createdAt.toISOString());
      expect(entry?.lastSeenAt).toBe(rows[rows.length - 1]?.createdAt.toISOString());
    });

    it('shows one entry per sign-in, not one per token', async () => {
      const pair = await signIn(CHROME_MAC);
      // Four rotations of the same session. A user with a laptop open all day
      // does this ninety-six times.
      let current = pair.refreshToken;
      for (let i = 0; i < 4; i += 1) {
        current = (
          await tokens.rotate(current, { userAgent: CHROME_MAC, ipAddress: '203.0.113.4' })
        ).refreshToken;
      }

      expect(await prisma.refreshToken.count()).toBe(5);
      expect(await sessions.list(await userId())).toHaveLength(1);
    });

    it('describes each session in words a person can check', async () => {
      await signIn(CHROME_MAC, '203.0.113.4');
      await signIn(FIREFOX_LINUX, '198.51.100.9');

      const list = await sessions.list(await userId());
      expect(list.map((entry) => entry.device).sort()).toEqual([
        'Chrome on macOS',
        'Firefox on Linux',
      ]);
      expect(list.map((entry) => entry.ipAddress).sort()).toEqual(['198.51.100.9', '203.0.113.4']);
    });

    it('marks the caller’s own session, so the wrong one is not revoked', async () => {
      await signIn(CHROME_MAC);
      const mine = await signIn(FIREFOX_LINUX);
      const familyId = tokens.familyOf(mine.accessToken);

      const list = await sessions.list(await userId(), familyId);
      expect(list.filter((entry) => entry.current)).toHaveLength(1);
      expect(list.find((entry) => entry.current)?.device).toBe('Firefox on Linux');
    });

    it('follows a session that moved rather than showing where it started', async () => {
      const pair = await signIn(CHROME_MAC, '203.0.113.4');
      await tokens.rotate(pair.refreshToken, { userAgent: CHROME_MAC, ipAddress: '198.51.100.9' });

      const [entry] = await sessions.list(await userId());
      expect(entry?.ipAddress).toBe('198.51.100.9');

      // But it is still one session, and it still says when it began — checked
      // against the rows rather than against elapsed time, because a rotation
      // this quick can share a timestamp with the sign-in it followed.
      const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(entry?.signedInAt).toBe(rows[0]?.createdAt.toISOString());
      expect(entry?.lastSeenAt).toBe(rows[1]?.createdAt.toISOString());
    });

    it('drops a session once it is revoked', async () => {
      await signIn(CHROME_MAC);
      const second = await signIn(FIREFOX_LINUX);
      await tokens.revokeToken(second.refreshToken);

      const list = await sessions.list(await userId());
      expect(list).toHaveLength(1);
      expect(list[0]?.device).toBe('Chrome on macOS');
    });
  });

  describe('revoking', () => {
    it('ends the session and every token in it', async () => {
      await signIn(CHROME_MAC);
      const other = await signIn(FIREFOX_LINUX);
      const familyId = tokens.familyOf(other.accessToken);

      await sessions.revoke(await userId(), familyId);

      await expect(tokens.rotate(other.refreshToken)).rejects.toBeInstanceOf(DomainError);
      expect(await sessions.list(await userId())).toHaveLength(1);
    });

    /**
     * Scoped by user id inside the query that finds it, so somebody else's
     * session is *not found* rather than found and refused. The two are
     * indistinguishable from outside, which is the point.
     */
    it('cannot end a session belonging to somebody else', async () => {
      const victim = await signIn(CHROME_MAC);
      const familyId = tokens.familyOf(victim.accessToken);

      await auth.register({
        email: 'attacker@test.local',
        password: PASSWORD,
        displayName: 'Attacker',
      });
      const attacker = await prisma.user.findFirstOrThrow({
        where: { email: 'attacker@test.local' },
      });

      await expect(sessions.revoke(attacker.id, familyId)).rejects.toMatchObject({
        code: TradingErrorCode.RESOURCE_NOT_FOUND,
      });
      // And the victim's session still works.
      await expect(tokens.rotate(victim.refreshToken)).resolves.toBeDefined();
    });

    it('writes an audit row naming the session', async () => {
      const pair = await signIn(CHROME_MAC);
      const familyId = tokens.familyOf(pair.accessToken);
      await sessions.revoke(await userId(), familyId);

      const audited = await prisma.auditLog.findFirst({ where: { action: 'SESSION_REVOKED' } });
      expect(audited?.resourceId).toBe(familyId);
    });
  });

  describe('a sign-in from a device not seen before', () => {
    it('says nothing about the first ever sign-in', async () => {
      await signIn(CHROME_MAC);
      expect(email.sent).toHaveLength(0);
    });

    it('says nothing when the same kind of device returns', async () => {
      await signIn(CHROME_MAC);
      await signIn(CHROME_MAC, '198.51.100.9');
      expect(email.sent).toHaveLength(0);
    });

    /**
     * Chrome updates itself every few weeks. Alerting on the version would mean
     * a notice every time it did, and a notice that arrives that often is not
     * read on the day it matters.
     */
    it('says nothing when the browser has merely updated itself', async () => {
      await signIn(CHROME_MAC);
      await signIn(CHROME_MAC_OLDER);
      expect(email.sent).toHaveLength(0);
    });

    it('tells the user when something genuinely different signs in', async () => {
      await signIn(CHROME_MAC);
      await signIn(FIREFOX_LINUX, '198.51.100.9');

      expect(email.sent).toHaveLength(1);
      const message = email.sent[0];
      expect(message?.to).toBe(EMAIL);
      expect(message?.text).toContain('Firefox on Linux');
      // A rough address, not a precise one: enough to recognise, not enough to
      // place, in a message that may itself be read by somebody else.
      expect(message?.text).toContain('198.51.100.x');
      expect(message?.text).not.toContain('198.51.100.9');
      // And it says what to do about it.
      expect(message?.text).toContain('change your password');
    });

    it('records it in the audit trail as well as sending mail', async () => {
      await signIn(CHROME_MAC);
      await signIn(FIREFOX_LINUX);

      const audited = await prisma.auditLog.findFirst({
        where: { action: 'LOGIN_FROM_NEW_DEVICE' },
      });
      expect(audited).not.toBeNull();
      expect(JSON.stringify(audited?.after)).toContain('Firefox on Linux');
    });

    /**
     * The user is already authenticated by the time this runs. A mail server
     * being down is not a reason to lock a trader out of their positions.
     */
    it('does not fail the sign-in when the notice cannot be sent', async () => {
      await signIn(CHROME_MAC);

      const failing = new (class extends EmailPort {
        async send(): Promise<void> {
          throw new Error('smtp is down');
        }
      })();
      const audit = new AuditService(prisma as unknown as PrismaService);
      const isolated = new SessionsService(prisma as unknown as PrismaService, audit, failing);

      await expect(
        isolated.noticeSignIn(
          { id: await userId(), email: EMAIL },
          { userAgent: FIREFOX_LINUX, ipAddress: '198.51.100.9' },
          'de6ca6ee-0000-4000-8000-000000000000',
        ),
      ).resolves.toEqual({ newDevice: false });
    });
  });
});
