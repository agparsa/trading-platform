import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import {
  DomainError,
  Permission,
  TradingErrorCode,
  UserRole,
  roleHasPermissions,
} from '@tp/shared-types';
import { AdminService } from '../../src/admin/admin.service';
import { AdjustmentsService } from '../../src/admin/adjustments.service';
import { AuditQueryService } from '../../src/admin/audit-query.service';
import { RiskConsoleService } from '../../src/admin/risk-console.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { EmailPort } from '../../src/auth/email/email.port';
import { PasswordService } from '../../src/auth/password.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { TotpService } from '../../src/auth/totp.service';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { base32Decode, codeForStep, stepFor } from '../../src/auth/totp';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;
const KEY = generateEncryptionKey('test');

class SilentEmailAdapter extends EmailPort {
  async send(): Promise<void> {}
}

/**
 * Administration.
 *
 * The cases worth writing down are the ones where an administrator's power has
 * a deliberate edge:
 *
 *  - suspending somebody must also end their sessions, or the suspension reads
 *    as an account that carried on trading afterwards;
 *  - closing an account with money at risk is refused;
 *  - a stop-out level set at or above the margin call is refused, because it
 *    would liquidate the account at the moment it should be warned;
 *  - and the balance can only ever be *appended to*, with a second factor, a
 *    reason, and an entry anybody can read back.
 */
suite('Administration (integration)', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;
  let admin: AdminService;
  let adjustments: AdjustmentsService;
  let auditQuery: AuditQueryService;
  let riskConsole: RiskConsoleService;
  let totp: TotpService;
  let secrets: SecretBox;
  let stack: TradingStack;

  /** An administrator with 2FA enrolled, and the secret to produce codes with. */
  async function anAdministrator(): Promise<{ id: string; secret: Buffer }> {
    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: `admin-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'not-a-real-hash',
        displayName: 'An Administrator',
        role: UserRole.ADMIN,
      },
    });
    const offer = await totp.beginEnrolment(user.id);
    const secret = base32Decode(offer.secret);
    await totp.activate(user.id, codeForStep(secret, stepFor(Date.now())));
    return { id: user.id, secret };
  }

  /** A code the administrator's app would be showing on the next step. */
  const nextCode = (secret: Buffer) => codeForStep(secret, stepFor(Date.now()) + 1);

  /**
   * A code valid *now*, for tests that spend more than one.
   *
   * Every code is single-use — that is the replay rule these adjustments rely
   * on — and the acceptance window is one step either side, so a second code
   * cannot simply be taken from a step further ahead. The honest way to have two
   * codes is for time to pass, so time passes.
   */
  const codeNow = (secret: Buffer) => codeForStep(secret, stepFor(Date.now()));

  function advanceOneStep(): void {
    vi.setSystemTime(new Date(Date.now() + 31_000));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    prismaService = prisma as unknown as PrismaService;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');

    const config = new ConfigService<Record<string, unknown>, true>({
      TOTP_ISSUER: 'Trading Platform',
    } as never);
    const audit = new AuditService(prismaService);
    secrets = new SecretBox(parseEncryptionKeys(KEY));
    totp = new TotpService(
      prismaService,
      secrets as never,
      new PasswordService(),
      audit,
      config as never,
    );
    const sessions = new SessionsService(prismaService, audit, new SilentEmailAdapter());

    admin = new AdminService(prismaService, audit, sessions);
    adjustments = new AdjustmentsService(prismaService, new LedgerService(), audit, totp);
    auditQuery = new AuditQueryService(prismaService);
    riskConsole = new RiskConsoleService(prismaService, stack.accountState);
  });

  // ─── People ──────────────────────────────────────────────────────────────

  describe('users', () => {
    it('finds a user by part of their email', async () => {
      const trader = await createAccount(prisma, { email: 'olivia.hart@example.com' });
      const found = await admin.findUsers({ search: 'olivia' });
      expect(found.map((row) => row.id)).toContain(trader.userId);
    });

    it('matches case-insensitively, because nobody types an email the way it was stored', async () => {
      await createAccount(prisma, { email: 'Olivia.Hart@example.com' });
      expect(await admin.findUsers({ search: 'OLIVIA.hart' })).toHaveLength(1);
    });

    /**
     * The permission is `users.read_any`; the *secret* is never any of their
     * business. Whether 2FA is on is operationally useful; when they enrolled
     * is not, and the sealed secret is not exposed at all.
     */
    it('says whether two-factor is on without exposing anything about it', async () => {
      const actor = await anAdministrator();
      const [row] = await admin.findUsers({ search: 'admin-' });
      expect(row?.twoFactorEnabled).toBe(true);
      expect(JSON.stringify(row)).not.toContain('totpSecret');
      expect(row?.id).toBe(actor.id);
    });

    it('returns a user with their accounts and their live sessions', async () => {
      const trader = await createAccount(prisma);
      const detail = await admin.userDetail(trader.userId);
      expect(detail.accounts.map((account) => account.id)).toContain(trader.accountId);
      expect(Array.isArray(detail.sessions)).toBe(true);
    });

    it('refuses a user that does not exist rather than returning an empty shell', async () => {
      await expect(admin.userDetail('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
        DomainError,
      );
    });

    /**
     * The half that is easy to forget. Marking somebody inactive without
     * revoking their refresh tokens leaves whoever is signed in able to keep
     * trading — which reads, from outside, as a suspension that did nothing.
     */
    it('ends every session when it suspends somebody', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);

      await prisma.refreshToken.createMany({
        data: [1, 2].map((n) => ({
          tenantId: DEFAULT_TENANT_ID,
          userId: trader.userId,
          tokenHash: `hash-${n}-${Date.now()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      });

      const result = await admin.setUserActive(actor.id, trader.userId, false, 'Fraud review');

      expect(result.isActive).toBe(false);
      expect(result.sessionsEnded).toBe(2);
      expect(
        await prisma.refreshToken.count({ where: { userId: trader.userId, revokedAt: null } }),
      ).toBe(0);
    });

    it('records who suspended whom, and why', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await admin.setUserActive(actor.id, trader.userId, false, 'Fraud review');

      const [entry] = await auditQuery.search({ action: 'user.suspended' });
      expect(entry?.actorId).toBe(actor.id);
      expect(entry?.resourceId).toBe(trader.userId);
      expect(JSON.stringify(entry?.after)).toContain('Fraud review');
    });

    /**
     * Not paternalism. An administrator who locks themselves out mid-incident
     * has removed the person who can undo it.
     */
    it('refuses to let an administrator suspend themselves', async () => {
      const actor = await anAdministrator();
      await expect(
        admin.setUserActive(actor.id, actor.id, false, 'a moment of doubt'),
      ).rejects.toBeInstanceOf(DomainError);
    });

    it('lets somebody be reinstated, and does not resurrect their old sessions', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await prisma.refreshToken.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          userId: trader.userId,
          tokenHash: `hash-${Date.now()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      await admin.setUserActive(actor.id, trader.userId, false, 'Fraud review');
      const back = await admin.setUserActive(actor.id, trader.userId, true, 'Cleared');

      expect(back.isActive).toBe(true);
      expect(
        await prisma.refreshToken.count({ where: { userId: trader.userId, revokedAt: null } }),
      ).toBe(0);
    });

    it('can end sessions without suspending, which is what a stolen laptop needs', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await prisma.refreshToken.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          userId: trader.userId,
          tokenHash: `hash-${Date.now()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const result = await admin.forceSignOut(actor.id, trader.userId, 'Laptop stolen');

      expect(result.sessionsEnded).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: trader.userId } })).isActive).toBe(
        true,
      );
    });
  });

  describe('putting a person into a role', () => {
    it('changes the role, ends every session, and records who and why', async () => {
      const actor = await anAdministrator();
      const person = await createAccount(prisma);
      await prisma.refreshToken.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          userId: person.userId,
          tokenHash: `hash-${Date.now()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const result = await admin.assignRole({
        actorId: actor.id,
        userId: person.userId,
        role: 'FINANCE',
        reason: 'Joins the finance desk from Monday.',
      });

      expect(result.role).toBe('FINANCE');
      // The role travels in the token: a live session would keep the old one.
      expect(result.sessionsEnded).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).role).toBe(
        'FINANCE',
      );
      const trail = await prisma.auditLog.findFirst({
        where: { action: 'user.role_assigned', resourceId: person.userId },
      });
      expect(trail?.actorId).toBe(actor.id);
      expect(trail?.before).toMatchObject({ role: 'USER' });
      expect(trail?.after).toMatchObject({ role: 'FINANCE' });
    });

    it('refuses to change your own role', async () => {
      const actor = await anAdministrator();
      await expect(
        admin.assignRole({
          actorId: actor.id,
          userId: actor.id,
          role: 'USER',
          reason: 'Stepping down.',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('ADMIN');
    });

    it('does nothing, and ends nothing, when the role is already held', async () => {
      const actor = await anAdministrator();
      const person = await createAccount(prisma);
      const result = await admin.assignRole({
        actorId: actor.id,
        userId: person.userId,
        role: 'USER',
        reason: 'No change.',
      });
      expect(result.sessionsEnded).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'user.role_assigned' } })).toBe(0);
    });
  });

  // ─── Accounts ────────────────────────────────────────────────────────────

  describe('accounts', () => {
    it('finds an account by number or by its owner’s email', async () => {
      const trader = await createAccount(prisma, { email: 'nadia@example.com' });
      const account = await prisma.account.findUniqueOrThrow({ where: { id: trader.accountId } });

      expect((await admin.findAccounts({ search: account.number }))[0]?.id).toBe(trader.accountId);
      expect((await admin.findAccounts({ search: 'nadia' }))[0]?.id).toBe(trader.accountId);
    });

    it('freezes an account and records the reason', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);

      await admin.setAccountStatus(actor.id, trader.accountId, 'SUSPENDED', 'Pending review');

      const account = await prisma.account.findUniqueOrThrow({ where: { id: trader.accountId } });
      expect(account.status).toBe('SUSPENDED');

      const [entry] = await auditQuery.search({ action: 'account.status_changed' });
      expect(JSON.stringify(entry?.after)).toContain('Pending review');
    });

    /**
     * CLOSE_ONLY is why the status is not a boolean. A trader who may still
     * close is a trader who can reduce their own risk; one frozen with
     * positions open has had their hands tied around a live exposure, and the
     * platform now owns it.
     */
    it('offers close-only as well as a full freeze', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await admin.setAccountStatus(actor.id, trader.accountId, 'CLOSE_ONLY', 'Reducing risk');
      expect(
        (await prisma.account.findUniqueOrThrow({ where: { id: trader.accountId } })).status,
      ).toBe('CLOSE_ONLY');
    });

    /**
     * CLOSED is terminal. Reaching it with positions open leaves exposure
     * nobody is watching and nobody may act on.
     */
    it('refuses to close an account that still holds a position', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '50000' });
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.10',
      });

      await expect(
        admin.setAccountStatus(actor.id, trader.accountId, 'CLOSED', 'Customer request'),
      ).rejects.toBeInstanceOf(DomainError);
    });

    it('changes an account’s risk thresholds', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);

      await admin.setAccountLimits(actor.id, trader.accountId, {
        marginCallLevelPercent: '120',
        stopOutLevelPercent: '60',
        maxOpenPositions: 5,
      });

      const settings = await prisma.accountSettings.findUniqueOrThrow({
        where: { accountId: trader.accountId },
      });
      expect(settings.marginCallLevelPercent.toString()).toBe('120');
      expect(settings.maxOpenPositions).toBe(5);
    });

    /**
     * The two levels have an order. Set the wrong way round, the account is
     * liquidated at the moment it was meant to be warned, and the warning never
     * fires at all.
     */
    it('refuses a stop-out at or above the margin call', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);

      await expect(
        admin.setAccountLimits(actor.id, trader.accountId, {
          marginCallLevelPercent: '100',
          stopOutLevelPercent: '100',
        }),
      ).rejects.toBeInstanceOf(DomainError);

      await expect(
        admin.setAccountLimits(actor.id, trader.accountId, {
          marginCallLevelPercent: '100',
          stopOutLevelPercent: '120',
        }),
      ).rejects.toBeInstanceOf(DomainError);
    });

    it('checks the level it is not changing against the one already stored', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await admin.setAccountLimits(actor.id, trader.accountId, {
        marginCallLevelPercent: '100',
        stopOutLevelPercent: '50',
      });

      // Raising only the stop-out, past the stored margin call.
      await expect(
        admin.setAccountLimits(actor.id, trader.accountId, { stopOutLevelPercent: '150' }),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  // ─── Adjustments ─────────────────────────────────────────────────────────

  describe('balance adjustments', () => {
    it('appends a ledger entry rather than editing the balance', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      const result = await adjustments.adjust(actor.id, {
        accountId: trader.accountId,
        amount: '250.00',
        type: 'DEPOSIT',
        reason: 'Wire received, reference 88213',
        totpCode: nextCode(actor.secret),
        idempotencyKey: `adj-${Date.now()}`,
      });

      expect(result.balanceAfter).toBe('1250.00');

      const entries = await prisma.balanceLedger.findMany({
        where: { accountId: trader.accountId },
        orderBy: { createdAt: 'asc' },
      });
      const adjustment = entries[entries.length - 1];
      expect(adjustment?.amount.toString()).toBe('250');
      expect(adjustment?.description).toBe('Wire received, reference 88213');
      expect(adjustment?.referenceType).toBe('admin_adjustment');
      // The actor is on the entry itself, not only in the audit log.
      expect(adjustment?.referenceId).toBe(actor.id);
    });

    /**
     * The whole point of demanding a second factor. This is the one action in
     * the platform that creates money, and a session left open on an unlocked
     * machine must not be enough to do it.
     */
    it('refuses without a valid code, and changes nothing', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      await expect(
        adjustments.adjust(actor.id, {
          accountId: trader.accountId,
          amount: '250.00',
          type: 'DEPOSIT',
          reason: 'Wire received, reference 88213',
          totpCode: '000000',
          idempotencyKey: `adj-${Date.now()}`,
        }),
      ).rejects.toBeInstanceOf(DomainError);

      const account = await prisma.account.findUniqueOrThrow({ where: { id: trader.accountId } });
      expect(account.balance.toString()).toBe('1000');
      expect(await prisma.balanceLedger.count({ where: { accountId: trader.accountId } })).toBe(1);
    });

    it('refuses an adjustment nobody could explain later', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      await expect(
        adjustments.adjust(actor.id, {
          accountId: trader.accountId,
          amount: '250.00',
          type: 'DEPOSIT',
          reason: 'fix',
          totpCode: nextCode(actor.secret),
          idempotencyKey: `adj-${Date.now()}`,
        }),
      ).rejects.toBeInstanceOf(DomainError);
    });

    it('refuses an adjustment of nothing', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      await expect(
        adjustments.adjust(actor.id, {
          accountId: trader.accountId,
          amount: '0',
          type: 'ADJUSTMENT',
          reason: 'Correcting a rounding difference',
          totpCode: nextCode(actor.secret),
          idempotencyKey: `adj-${Date.now()}`,
        }),
      ).rejects.toBeInstanceOf(DomainError);
    });

    it('debits, and refuses a debit that would go below zero', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      advanceOneStep();
      const debited = await adjustments.adjust(actor.id, {
        accountId: trader.accountId,
        amount: '-400',
        type: 'WITHDRAWAL',
        reason: 'Withdrawal to bank account ending 4417',
        totpCode: codeNow(actor.secret),
        idempotencyKey: `adj-a-${Date.now()}`,
      });
      expect(debited.balanceAfter).toBe('600.00');

      advanceOneStep();
      await expect(
        adjustments.adjust(actor.id, {
          accountId: trader.accountId,
          amount: '-1000',
          type: 'WITHDRAWAL',
          reason: 'Withdrawal that does not fit',
          totpCode: codeNow(actor.secret),
          idempotencyKey: `adj-b-${Date.now()}`,
        }),
      ).rejects.toBeInstanceOf(DomainError);
    });

    /**
     * Enforced by a unique constraint, not by remembering. A retried request
     * loses the insert race and is served the first result.
     */
    it('cannot credit twice on a retry', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });
      const key = `adj-once-${Date.now()}`;

      advanceOneStep();
      const first = await adjustments.adjust(actor.id, {
        accountId: trader.accountId,
        amount: '250',
        type: 'DEPOSIT',
        reason: 'Wire received, reference 88213',
        totpCode: codeNow(actor.secret),
        idempotencyKey: key,
      });

      // A genuine retry, a moment later, with the code the app is showing then.
      advanceOneStep();
      const second = await adjustments.adjust(actor.id, {
        accountId: trader.accountId,
        amount: '250',
        type: 'DEPOSIT',
        reason: 'Wire received, reference 88213',
        totpCode: codeNow(actor.secret),
        idempotencyKey: key,
      });

      expect(second.entryId).toBe(first.entryId);
      expect(
        (
          await prisma.account.findUniqueOrThrow({ where: { id: trader.accountId } })
        ).balance.toString(),
      ).toBe('1250');
    });

    it('writes an audit record naming the entry it created', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma, { balance: '1000' });

      const result = await adjustments.adjust(actor.id, {
        accountId: trader.accountId,
        amount: '250',
        type: 'DEPOSIT',
        reason: 'Wire received, reference 88213',
        totpCode: nextCode(actor.secret),
        idempotencyKey: `adj-${Date.now()}`,
      });

      const [entry] = await auditQuery.search({ action: 'account.balance_adjusted' });
      expect(entry?.actorId).toBe(actor.id);
      expect(JSON.stringify(entry?.after)).toContain(result.entryId);
    });
  });

  // ─── Risk console ────────────────────────────────────────────────────────

  describe('risk console', () => {
    it('says nothing about an account with no margin committed', async () => {
      await createAccount(prisma, { balance: '5000' });
      expect(await riskConsole.atRisk()).toEqual([]);
    });

    /**
     * Omitting the threshold means *every account holding margin*, not a very
     * large number. A well-capitalised account sits at several hundred thousand
     * percent, so a filter that spelled "anything" as 100,000 would hide the
     * accounts it claimed to be showing — which a risk console must not do.
     */
    it('lists every account holding margin when no threshold is given', async () => {
      const trader = await createAccount(prisma, { balance: '5000000' });
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.01',
      });

      const unfiltered = await riskConsole.atRisk();
      expect(unfiltered.map((row) => row.accountId)).toContain(trader.accountId);
      // The same account is far above any sane threshold.
      expect(Number(unfiltered[0]?.marginLevel)).toBeGreaterThan(100_000);
      expect(await riskConsole.atRisk({ belowPercent: 1_000 })).toEqual([]);
    });

    it('lists an account whose margin level is under the threshold, worst first', async () => {
      const comfortable = await createAccount(prisma, { balance: '500000' });
      const stretched = await createAccount(prisma, { balance: '5000' });

      for (const trader of [comfortable, stretched]) {
        await stack.orders.openPosition(trader.userId, {
          accountId: trader.accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '1.00',
        });
      }

      const rows = await riskConsole.atRisk();
      expect(rows.map((row) => row.accountId)).toContain(stretched.accountId);
      // Worst first: the small account has the lower margin level.
      expect(rows[0]?.accountId).toBe(stretched.accountId);
      expect(Number(rows[0]?.marginLevel)).toBeLessThan(Number(rows[1]?.marginLevel));
    });

    it('carries the thresholds it should be read against', async () => {
      const trader = await createAccount(prisma, { balance: '5000' });
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1.00',
      });

      const [row] = await riskConsole.atRisk();
      expect(row?.stopOutLevelPercent).not.toBeNull();
      expect(row?.marginCallLevelPercent).not.toBeNull();
    });

    it('reports open volume by instrument and side', async () => {
      const trader = await createAccount(prisma, { balance: '500000' });
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '1.00',
      });
      await stack.orders.openPosition(trader.userId, {
        accountId: trader.accountId,
        symbol: 'XAUUSD',
        side: 'SELL',
        volume: '0.40',
      });

      const [row] = await riskConsole.exposure();
      expect(row?.symbol).toBe('XAUUSD');
      expect(Number(row?.longVolume)).toBeCloseTo(1, 6);
      expect(Number(row?.shortVolume)).toBeCloseTo(0.4, 6);
      expect(Number(row?.netVolume)).toBeCloseTo(0.6, 6);
    });
  });

  // ─── Permissions ─────────────────────────────────────────────────────────

  describe('who may do what', () => {
    /**
     * `accounts.adjust` is not implied by being able to freeze an account, and
     * this is where that stays true. If a future role gains it by accident,
     * this test is what says so.
     */
    it('gives the power to move money to administrators and to nobody else', () => {
      expect(roleHasPermissions(UserRole.ADMIN, [Permission.ACCOUNTS_ADJUST])).toBe(true);
      for (const role of [
        UserRole.USER,
        UserRole.SUPPORT,
        UserRole.OPERATOR,
        UserRole.RISK_MANAGER,
      ]) {
        expect(roleHasPermissions(role, [Permission.ACCOUNTS_ADJUST])).toBe(false);
      }
    });

    it('lets support read people without letting them change anything', () => {
      expect(roleHasPermissions(UserRole.SUPPORT, [Permission.USERS_READ_ANY])).toBe(true);
      expect(roleHasPermissions(UserRole.SUPPORT, [Permission.USERS_MANAGE])).toBe(false);
      expect(roleHasPermissions(UserRole.SUPPORT, [Permission.ACCOUNTS_MANAGE])).toBe(false);
    });

    it('keeps a trader out of every one of them', () => {
      for (const permission of [
        Permission.USERS_READ_ANY,
        Permission.USERS_MANAGE,
        Permission.ACCOUNTS_ADJUST,
        Permission.ACCOUNTS_READ_ANY,
        Permission.AUDIT_READ,
      ]) {
        expect(roleHasPermissions(UserRole.USER, [permission])).toBe(false);
      }
    });
  });

  // ─── Audit ───────────────────────────────────────────────────────────────

  describe('the audit trail', () => {
    it('is readable, filtered and newest first', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);

      await admin.setUserActive(actor.id, trader.userId, false, 'Fraud review');
      await admin.setUserActive(actor.id, trader.userId, true, 'Cleared');

      const rows = await auditQuery.search({ resourceType: 'user' });
      expect(rows[0]?.action).toBe('user.reinstated');
      expect(rows[1]?.action).toBe('user.suspended');
      expect(rows[0]?.actorEmail).toContain('admin-');
    });

    it('matches an action prefix, so a caller need not know the full list', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await admin.setAccountStatus(actor.id, trader.accountId, 'SUSPENDED', 'Pending review');

      expect(await auditQuery.search({ action: 'account.' })).toHaveLength(1);
      expect(await auditQuery.search({ action: 'user.' })).toHaveLength(0);
    });

    it('offers the vocabulary the filter needs rather than a hard-coded list', async () => {
      const actor = await anAdministrator();
      const trader = await createAccount(prisma);
      await admin.setUserActive(actor.id, trader.userId, false, 'Fraud review');

      const actions = await auditQuery.actions();
      expect(actions.map((row) => row.action)).toContain('user.suspended');
    });

    /**
     * There is no write path in `AuditQueryService`. §22 asks for a trail that
     * is immutable from the admin UI, and the way to get one is not a flag — it
     * is the absence of a method.
     */
    it('offers no way to change what it holds', () => {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(auditQuery));
      expect(methods.sort()).toEqual(['actions', 'constructor', 'search']);
    });
  });
});
