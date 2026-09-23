import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { TradingErrorCode, UserRole, seedRoles } from '@tp/shared-types';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import { AuthService } from '../../src/auth/auth.service';
import { EmailPort } from '../../src/auth/email/email.port';
import { InvitesService } from '../../src/auth/invites.service';
import { SessionsService } from '../../src/auth/sessions.service';
import { TokenService } from '../../src/auth/token.service';
import { TotpService } from '../../src/auth/totp.service';
import { BrokersService } from '../../src/brokers/brokers.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { RolesService } from '../../src/permissions/roles.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantResolver } from '../../src/tenancy/tenant-resolver.service';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  testPasswordService,
} from './harness';
import { redisStub } from './redis-stub';

const suite = hasTestDatabase ? describe : describe.skip;

class SilentEmail extends EmailPort {
  constructor() {
    super('no-reply@test.local');
  }

  async send(): Promise<void> {}
}

const CONFIG = {
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
  REGISTRATION_MODE: 'open',
  INVITE_CODE_TTL_HOURS: 168,
  TENANT_DEFAULT_SLUG: DEFAULT_TENANT_SLUG,
  TENANT_HOST_STRICT: false,
};

/**
 * Brokers are tenants the platform creates. The tests run in the harness's
 * default tenant, which is the PLATFORM one, and open a second scope to act
 * as the broker — the way a request on the broker's hostname would.
 */
suite('Brokers (integration)', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;
  let brokers: BrokersService;
  let auth: AuthService;
  let resolver: TenantResolver;
  let platformAdmin: { id: string; role: string };

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
    const config = new ConfigService<Record<string, unknown>, true>(CONFIG as never);
    const audit = new AuditService(prismaService);
    const roles = new RolesService(prismaService, redisStub().service, audit);
    const invites = new InvitesService(prismaService, audit, roles, config as never);
    resolver = new TenantResolver(prismaService, config as never);
    brokers = new BrokersService(prismaService, audit, invites, resolver);

    const passwords = testPasswordService();
    const secrets = new SecretBox(parseEncryptionKeys(CONFIG.SECRET_ENCRYPTION_KEYS)) as never;
    auth = new AuthService(
      prismaService,
      passwords,
      new TokenService(new JwtService({}), config as never, prismaService),
      new TotpService(prismaService, secrets, passwords, audit, config as never),
      new SessionsService(prismaService, audit, new SilentEmail()),
      new AccountsService(
        prismaService,
        new AccountAccessService(prismaService),
        new LedgerService(),
        config as never,
      ),
      audit,
      new SilentEmail(),
      invites,
      config as never,
    );

    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'platform@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Platform',
        role: UserRole.PLATFORM_SUPER_ADMIN,
      },
    });
    platformAdmin = { id: user.id, role: user.role };
  });

  describe('what a tenant of each kind seeds', () => {
    it('gives the platform every role and a broker everything but the platform ones', async () => {
      const platform = await prisma.role.findMany({
        where: { tenantId: DEFAULT_TENANT_ID },
        select: { key: true },
      });
      expect(platform.map((row) => row.key).sort()).toEqual(
        seedRoles('PLATFORM')
          .map((role) => role.key)
          .sort(),
      );
      expect(platform.map((row) => row.key)).toContain('PLATFORM_SUPER_ADMIN');

      const { broker } = await brokers.create(platformAdmin, { slug: 'acme', name: 'Acme' });
      const seeded = await withTenant({ tenantId: broker.id, slug: 'acme', kind: 'BROKER' }, () =>
        prisma.role.findMany({ select: { key: true } }),
      );
      const keys = seeded.map((row) => row.key).sort();
      expect(keys).toEqual(
        seedRoles('BROKER')
          .map((role) => role.key)
          .sort(),
      );
      expect(keys).toContain('BROKER_OWNER');
      expect(keys).not.toContain('PLATFORM_SUPER_ADMIN');
    });
  });

  describe('creating a broker', () => {
    it('creates the tenant, seeds its roles, and returns the owner invitation once', async () => {
      const created = await brokers.create(platformAdmin, {
        slug: 'Acme-FX',
        name: 'Acme FX',
        legalName: 'Acme FX Ltd',
        primaryHost: 'trade.acme.example',
        defaultExecutionMode: 'EXTERNAL_BROKER',
      });

      expect(created.broker).toMatchObject({
        slug: 'acme-fx',
        name: 'Acme FX',
        legalName: 'Acme FX Ltd',
        primaryHost: 'trade.acme.example',
        status: 'ACTIVE',
        defaultExecutionMode: 'EXTERNAL_BROKER',
        users: 0,
      });
      expect(created.ownerInvite.grantsRole).toBe('BROKER_OWNER');
      expect(created.ownerInvite.code).toHaveLength(24);

      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme-fx' } });
      expect(tenant.kind).toBe('BROKER');

      // The invitation lives in the broker's tenant, with only a hash of the code.
      const invite = await withTenant({ tenantId: tenant.id, slug: 'acme-fx' }, () =>
        prisma.inviteCode.findUniqueOrThrow({ where: { id: created.ownerInvite.id } }),
      );
      expect(invite.tenantId).toBe(tenant.id);
      expect(invite.grantsRole).toBe('BROKER_OWNER');
      expect(invite.codeHash).not.toContain(created.ownerInvite.code);
      expect(invite.createdById).toBe(platformAdmin.id);

      // The platform's audit log names who did it and the invitation's fingerprint, not the code.
      const trail = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'tenant.created', resourceId: tenant.id },
      });
      expect(trail.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(trail.actorId).toBe(platformAdmin.id);
      expect(trail.after).toMatchObject({
        ownerInviteFingerprint: created.ownerInvite.fingerprint,
      });
      expect(JSON.stringify(trail.after)).not.toContain(created.ownerInvite.code);

      // The resolver serves the new hostname without a restart.
      const context = await resolver.forHost('trade.acme.example:443');
      expect(context).toMatchObject({ tenantId: tenant.id, slug: 'acme-fx', kind: 'BROKER' });
    });

    it('lets whoever redeems the invitation register as the owner, in the new tenant only', async () => {
      const created = await brokers.create(platformAdmin, { slug: 'acme', name: 'Acme' });
      const scope = { tenantId: created.broker.id, slug: 'acme', kind: 'BROKER' as const };

      const { userId } = await withTenant(scope, () =>
        auth.register({
          email: 'owner@acme.example',
          password: 'a-sufficiently-long-passphrase',
          displayName: 'Owner',
          inviteCode: created.ownerInvite.code,
        }),
      );
      const owner = await withTenant(scope, () =>
        prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      );
      expect(owner.role).toBe('BROKER_OWNER');
      expect(owner.tenantId).toBe(created.broker.id);

      // The platform tenant does not see the owner, and the code is spent.
      expect(await prisma.user.findFirst({ where: { email: 'owner@acme.example' } })).toBeNull();
      await expect(
        withTenant(scope, () =>
          auth.register({
            email: 'second@acme.example',
            password: 'a-sufficiently-long-passphrase',
            displayName: 'Second',
            inviteCode: created.ownerInvite.code,
          }),
        ),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect((await brokers.get(created.broker.id)).users).toBe(1);
    });

    it('refuses a slug or host another tenant already has', async () => {
      await brokers.create(platformAdmin, { slug: 'acme', name: 'Acme', primaryHost: 'a.example' });
      await expect(
        brokers.create(platformAdmin, { slug: 'ACME', name: 'Acme again' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      await expect(
        brokers.create(platformAdmin, { slug: 'other', name: 'Other', primaryHost: 'A.example' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
      expect(await prisma.tenant.count({ where: { kind: 'BROKER' } })).toBe(1);
    });
  });

  describe('only from the platform', () => {
    it('refuses every operation from a broker tenant, whatever the caller holds', async () => {
      const { broker } = await brokers.create(platformAdmin, { slug: 'acme', name: 'Acme' });
      const asBroker = { tenantId: broker.id, slug: 'acme', kind: 'BROKER' as const };

      await expect(
        withTenant(asBroker, () => brokers.create(platformAdmin, { slug: 'sub', name: 'Sub' })),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
      await expect(withTenant(asBroker, () => brokers.list())).rejects.toMatchObject({
        code: TradingErrorCode.FORBIDDEN,
      });
      await expect(
        withTenant(asBroker, () => brokers.setStatus(platformAdmin, broker.id, 'SUSPENDED', 'try')),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
      // And from no tenant at all, which is what a background job would be.
      await expect(
        withoutTenantScope('the test is proving this is refused', () => brokers.list()),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
      expect(await prisma.tenant.count({ where: { kind: 'BROKER' } })).toBe(1);
    });
  });

  describe('status', () => {
    it('suspends a broker, which stops its hostname being served, and records why', async () => {
      const { broker } = await brokers.create(platformAdmin, {
        slug: 'acme',
        name: 'Acme',
        primaryHost: 'acme.example',
      });
      await resolver.forHost('acme.example');

      const suspended = await brokers.setStatus(
        platformAdmin,
        broker.id,
        'SUSPENDED',
        'Regulator asked.',
      );
      expect(suspended.status).toBe('SUSPENDED');
      await expect(resolver.forHost('acme.example')).rejects.toMatchObject({
        code: TradingErrorCode.FORBIDDEN,
      });
      expect(await resolver.byId(broker.id)).toBeNull();

      const trail = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'tenant.status_changed', resourceId: broker.id },
      });
      expect(trail.before).toMatchObject({ status: 'ACTIVE' });
      expect(trail.after).toMatchObject({ status: 'SUSPENDED', reason: 'Regulator asked.' });

      const back = await brokers.setStatus(platformAdmin, broker.id, 'ACTIVE', 'Cleared.');
      expect(back.status).toBe('ACTIVE');
      expect((await resolver.forHost('acme.example')).tenantId).toBe(broker.id);
    });

    it('does not reopen a closed broker', async () => {
      const { broker } = await brokers.create(platformAdmin, { slug: 'acme', name: 'Acme' });
      await brokers.setStatus(platformAdmin, broker.id, 'CLOSED', 'Wound up.');
      await expect(
        brokers.setStatus(platformAdmin, broker.id, 'ACTIVE', 'Changed our minds.'),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('is not a way to reach the platform tenant itself', async () => {
      await expect(
        brokers.setStatus(platformAdmin, DEFAULT_TENANT_ID, 'SUSPENDED', 'Oops.'),
      ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
      await expect(brokers.get(DEFAULT_TENANT_ID)).rejects.toMatchObject({
        code: TradingErrorCode.RESOURCE_NOT_FOUND,
      });
    });
  });
});
