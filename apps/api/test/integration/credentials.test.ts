import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { parseCredential } from '@tp/crypto-core';
import { DomainError, Permission, TradingErrorCode, UserRole } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { AuditService } from '../../src/common/audit/audit.service';
import { PasswordService } from '../../src/auth/password.service';
import { CredentialsService } from '../../src/credentials/credentials.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { RolesService } from '../../src/permissions/roles.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;
const PASSWORD = 'correct horse battery staple 9';
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

/**
 * Redis, as far as this service uses it: one counter per credential per
 * minute. In memory so the tests decide what minute it is and what Redis
 * does, including dying.
 */
function redisStub(): { service: RedisService; counters: Map<string, number>; failing: boolean } {
  const counters = new Map<string, number>();
  const state = { failing: false };
  const client = {
    incr: async (key: string) => {
      if (state.failing) throw new Error('Redis is away');
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
  };
  const service = {
    client,
    publisher: { publish: async () => 1 },
    subscriber: { subscribe: async () => undefined, on: () => undefined },
  } as unknown as RedisService;
  return {
    service,
    counters,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
  };
}

suite('API keys and service tokens', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;
  let passwords: PasswordService;
  let audit: AuditService;
  let roles: RolesService;
  let redis: ReturnType<typeof redisStub>;
  let raised: Array<{ userId: string; kind: string; body: string }>;
  let service: CredentialsService;

  const configure = (over: Record<string, unknown> = {}) =>
    new ConfigService<Record<string, unknown>, true>({
      API_KEY_MAX_TTL_DAYS: 365,
      API_KEY_DEFAULT_TTL_DAYS: 90,
      API_KEY_MAX_PER_USER: 3,
      API_KEY_RATE_LIMIT_PER_MINUTE: 300,
      ...over,
    } as never) as unknown as ConfigService<never, true>;

  const build = (over: Record<string, unknown> = {}) =>
    new CredentialsService(
      prismaService,
      redis.service,
      audit,
      passwords,
      roles,
      {
        raise: (job: { userId: string; kind: string; body: string }) => {
          raised.push(job);
          return Promise.resolve();
        },
      } as unknown as NotificationsService,
      configure(over),
    );

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    prismaService = prisma as unknown as PrismaService;
    passwords = new PasswordService();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    audit = new AuditService(prismaService);
    redis = redisStub();
    roles = new RolesService(prismaService, redis.service, audit);
    raised = [];
    service = build();
  });

  let hashed: string | undefined;
  async function person(
    role: UserRole = UserRole.USER,
    overrides: { email?: string; tenantId?: string; isActive?: boolean } = {},
  ): Promise<{ id: string; role: UserRole; email: string }> {
    hashed ??= await passwords.hash(PASSWORD);
    const email =
      overrides.email ??
      `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const tenantId = overrides.tenantId ?? DEFAULT_TENANT_ID;
    const create = () =>
      prisma.user.create({
        data: {
          tenantId,
          email,
          passwordHash: hashed as string,
          displayName: role,
          role,
          emailVerified: true,
          isActive: overrides.isActive ?? true,
        },
      });
    const user =
      tenantId === DEFAULT_TENANT_ID
        ? await create()
        : await withTenant({ tenantId, slug: 'other' }, create);
    return { id: user.id, role, email };
  }

  const mint = (user: { id: string; role: UserRole }, over: Record<string, unknown> = {}) =>
    service.mintApiKey({
      user,
      name: 'trading bot',
      permissions: [Permission.ORDERS_CREATE, Permission.POSITIONS_READ],
      password: PASSWORD,
      ...over,
    });

  const refusal = async (promise: Promise<unknown>): Promise<DomainError> => {
    const error = await promise.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  };

  describe('minting a key', () => {
    it('hands the secret back once and stores only its hash and its name', async () => {
      const trader = await person();
      const { key, token } = await mint(trader);

      const parsed = parseCredential(token);
      expect(parsed?.kind).toBe('api_key');
      expect(key.fingerprint).toBe(parsed?.fingerprint);
      expect(key.status).toBe('ACTIVE');
      expect(key.permissions).toEqual([Permission.ORDERS_CREATE, Permission.POSITIONS_READ]);

      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(row.secretHash).toHaveLength(64);
      expect(token).not.toContain(row.secretHash);
      expect(row.secretHash).not.toContain(parsed?.secret ?? 'x');
      // Nothing that leaves the service afterwards carries the secret.
      const listed = await service.listApiKeys(trader.id);
      expect(JSON.stringify(listed)).not.toContain(parsed?.secret ?? 'x');

      const audited = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'api_key.minted' },
      });
      expect(audited.actorId).toBe(trader.id);
      expect(JSON.stringify(audited.after)).toContain(key.fingerprint);
      expect(JSON.stringify(audited.after)).not.toContain(parsed?.secret ?? 'x');

      expect(raised).toHaveLength(1);
      expect(raised[0]?.kind).toBe('api_key.minted');
      expect(raised[0]?.body).not.toContain(parsed?.secret ?? 'x');
    });

    it('asks for the password again, and mints nothing without it', async () => {
      const trader = await person();
      const error = await refusal(mint(trader, { password: 'not it' }));
      expect(error.code).toBe(TradingErrorCode.UNAUTHENTICATED);
      expect(await prisma.apiKey.count()).toBe(0);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('refuses every capability it cannot carry, all at once, with the reason for each', async () => {
      const trader = await person();
      const error = await refusal(
        mint(trader, {
          permissions: [
            'orders.creat',
            Permission.WALLET_ADJUST,
            Permission.ACCOUNTS_READ_ANY,
            Permission.API_KEYS_MANAGE,
            Permission.ORDERS_CREATE,
          ],
        }),
      );
      expect(error.code).toBe(TradingErrorCode.VALIDATION_FAILED);
      expect(error.message).toContain('"orders.creat" is not a capability');
      expect(error.message).toContain('wallet.adjust may not be carried by a key');
      expect(error.message).toContain('accounts.read_any is not something you can do');
      expect(error.message).toContain('api_keys.manage may not be carried by a key');
      expect(error.message).not.toContain('orders.create ');
      expect(await prisma.apiKey.count()).toBe(0);
    });

    it('needs at least one capability', async () => {
      const trader = await person();
      const error = await refusal(mint(trader, { permissions: [] }));
      expect(error.code).toBe(TradingErrorCode.VALIDATION_FAILED);
    });

    it('bounds the lifetime and the rate limit, and defaults both', async () => {
      const trader = await person();
      const { key } = await mint(trader);
      const days = (new Date(key.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
      expect(key.rateLimitPerMinute).toBe(300);

      expect((await refusal(mint(trader, { expiresInDays: 0 }))).code).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
      expect((await refusal(mint(trader, { expiresInDays: 366 }))).code).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
      expect((await refusal(mint(trader, { rateLimitPerMinute: 301 }))).code).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
      const { key: short } = await mint(trader, { expiresInDays: 7, rateLimitPerMinute: 10 });
      expect(short.rateLimitPerMinute).toBe(10);
    });

    it('caps how many live keys one person holds, counting neither revoked nor expired ones', async () => {
      const trader = await person();
      const first = await mint(trader);
      await mint(trader);
      await mint(trader);
      const error = await refusal(mint(trader));
      expect(error.message).toContain('3 live keys');

      await service.revokeApiKey({ userId: trader.id, id: first.key.id });
      await expect(mint(trader)).resolves.toBeDefined();
    });
  });

  describe('presenting a key', () => {
    it('yields the holder, bounded by the key, and records the use', async () => {
      const trader = await person();
      const { key, token } = await mint(trader);

      const principal = await service.authenticate(token, TENANT, '203.0.113.9');
      expect(principal.kind).toBe('api_key');
      if (principal.kind !== 'api_key') throw new Error('unreachable');
      expect(principal.user.id).toBe(trader.id);
      expect(principal.credentialId).toBe(key.id);
      expect([...principal.permissions].sort()).toEqual(
        [Permission.ORDERS_CREATE, Permission.POSITIONS_READ].sort(),
      );

      await service.authenticate(token, TENANT, '203.0.113.9');
      await service.drain();
      const [listed] = await service.listApiKeys(trader.id);
      expect(listed?.usage7d).toEqual({ requests: 2, refused: 0, throttled: 0 });
      expect(listed?.lastUsedAt).not.toBeNull();
      expect(listed?.lastUsedIp).toBe('203.0.113.9');
    });

    it('is bounded by what the holder may do *now*, not at minting', async () => {
      const trader = await person();
      const { token } = await mint(trader);
      // A move into SUPPORT, which cannot place orders.
      await prisma.user.update({ where: { id: trader.id }, data: { role: UserRole.SUPPORT } });

      const principal = await service.authenticate(token, TENANT, undefined);
      expect(principal.permissions.has(Permission.ORDERS_CREATE)).toBe(false);
      expect(principal.permissions.has(Permission.POSITIONS_READ)).toBe(true);
    });

    it('says the same thing to a wrong secret and to a key that never existed', async () => {
      const trader = await person();
      const { token } = await mint(trader);
      const wrong = token.slice(0, -4) + (token.endsWith('aaaa') ? 'bbbb' : 'aaaa');
      const unknown = token.replace(/^tpk_[^_]+/, 'tpk_zzzzzzzzzzzz');

      const one = await refusal(service.authenticate(wrong, TENANT, undefined));
      const two = await refusal(service.authenticate(unknown, TENANT, undefined));
      const three = await refusal(service.authenticate('tpk_not-a-key', TENANT, undefined));
      expect(one.message).toBe('Invalid credential');
      expect(two.message).toBe(one.message);
      expect(three.message).toBe(one.message);
    });

    it('refuses a revoked key, an expired key, and a suspended holder', async () => {
      const trader = await person();
      const { key, token } = await mint(trader);
      await service.revokeApiKey({ userId: trader.id, id: key.id, reason: 'laptop stolen' });
      expect((await refusal(service.authenticate(token, TENANT, undefined))).message).toContain(
        'revoked',
      );

      const { key: brief, token: briefToken } = await mint(trader, { expiresInDays: 1 });
      await prisma.$executeRawUnsafe(`ALTER TABLE api_keys DISABLE TRIGGER api_keys_minted_fixed`);
      await prisma.apiKey.update({
        where: { id: brief.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await prisma.$executeRawUnsafe(`ALTER TABLE api_keys ENABLE TRIGGER api_keys_minted_fixed`);
      expect(
        (await refusal(service.authenticate(briefToken, TENANT, undefined))).message,
      ).toContain('expired');

      const { token: live } = await mint(trader);
      await prisma.user.update({ where: { id: trader.id }, data: { isActive: false } });
      expect((await refusal(service.authenticate(live, TENANT, undefined))).code).toBe(
        TradingErrorCode.FORBIDDEN,
      );
    });

    it('does not find a key minted under another tenant', async () => {
      const other = await createTenant(prisma, 'other-firm');
      const elsewhere = await person(UserRole.USER, { tenantId: other });
      const { token } = await withTenant({ tenantId: other, slug: 'other-firm' }, () =>
        mint(elsewhere),
      );

      const error = await refusal(service.authenticate(token, TENANT, undefined));
      expect(error.message).toBe('Invalid credential');
      await expect(
        withTenant({ tenantId: other, slug: 'other-firm' }, () =>
          service.authenticate(token, { tenantId: other, slug: 'other-firm' }, undefined),
        ),
      ).resolves.toMatchObject({ kind: 'api_key' });
    });

    it('throttles a key at its own limit, counts it, and carries on when Redis is away', async () => {
      const trader = await person();
      const { key, token } = await mint(trader, { rateLimitPerMinute: 2 });

      await service.authenticate(token, TENANT, undefined);
      await service.authenticate(token, TENANT, undefined);
      const error = await refusal(service.authenticate(token, TENANT, undefined));
      expect(error.code).toBe(TradingErrorCode.RATE_LIMITED);
      expect(error.message).toContain('2 requests a minute');
      await service.drain();
      const [listed] = await service.listApiKeys(trader.id);
      expect(listed?.id).toBe(key.id);
      expect(listed?.usage7d).toEqual({ requests: 2, refused: 0, throttled: 1 });

      redis.failing = true;
      await expect(service.authenticate(token, TENANT, undefined)).resolves.toMatchObject({
        kind: 'api_key',
      });
    });
  });

  describe('revoking', () => {
    it('ends the key for its holder, once, with a record', async () => {
      const trader = await person();
      const { key } = await mint(trader);

      const revoked = await service.revokeApiKey({ userId: trader.id, id: key.id });
      expect(revoked.status).toBe('REVOKED');
      expect(revoked.revokedReason).toBe('Revoked by its holder');

      const again = await refusal(service.revokeApiKey({ userId: trader.id, id: key.id }));
      expect(again.code).toBe(TradingErrorCode.INVALID_STATE_TRANSITION);
      const audited = await prisma.auditLog.findMany({ where: { action: 'api_key.revoked' } });
      expect(audited).toHaveLength(1);
    });

    it('does not let one person revoke another’s key, or see it', async () => {
      const trader = await person();
      const other = await person();
      const { key } = await mint(trader);
      const error = await refusal(service.revokeApiKey({ userId: other.id, id: key.id }));
      expect(error.code).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
      expect(await service.listApiKeys(other.id)).toEqual([]);
    });

    it('lets staff revoke anyone’s, and tells the holder why', async () => {
      const trader = await person();
      const risk = await person(UserRole.RISK_MANAGER);
      const { key } = await mint(trader);
      raised.length = 0;

      const revoked = await service.revokeAnyApiKey({
        actorId: risk.id,
        id: key.id,
        reason: 'The key was seen in a public repository',
      });
      expect(revoked.status).toBe('REVOKED');
      expect(revoked.email).toBe(trader.email);
      expect(raised).toEqual([
        expect.objectContaining({ userId: trader.id, kind: 'api_key.revoked' }),
      ]);
      const audited = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'api_key.revoked' },
      });
      expect(audited.actorId).toBe(risk.id);
      expect(audited.actorType).toBe('ADMIN');
    });

    it('lists every key in the tenant for staff, searchable by holder', async () => {
      const a = await person(UserRole.USER, { email: 'alice@test.local' });
      const b = await person(UserRole.USER, { email: 'bob@test.local' });
      await mint(a);
      await mint(b);
      const all = await service.listAllApiKeys({});
      expect(all.map((row) => row.email).sort()).toEqual(['alice@test.local', 'bob@test.local']);
      const found = await service.listAllApiKeys({ search: 'bob' });
      expect(found.map((row) => row.email)).toEqual(['bob@test.local']);
    });
  });

  describe('service tokens', () => {
    it('are minted by an administrator with reads across the tenant, and nothing else', async () => {
      const admin = await person(UserRole.ADMIN);
      const { token, secret } = await service.mintServiceToken({
        actor: admin,
        name: 'PropFA metrics',
        permissions: [Permission.ACCOUNTS_READ_ANY, Permission.RISK_READ],
      });
      expect(parseCredential(secret)?.kind).toBe('service_token');
      expect(token.createdBy).toBe(admin.email);
      expect(token.permissions).toEqual([Permission.ACCOUNTS_READ_ANY, Permission.RISK_READ]);

      const principal = await service.authenticate(secret, TENANT, '198.51.100.7');
      expect(principal.kind).toBe('service_token');
      expect([...principal.permissions].sort()).toEqual(
        [Permission.ACCOUNTS_READ_ANY, Permission.RISK_READ].sort(),
      );

      const error = await refusal(
        service.mintServiceToken({
          actor: admin,
          name: 'bot',
          permissions: [Permission.ORDERS_CREATE, Permission.ACCOUNTS_MANAGE],
        }),
      );
      expect(error.message).toContain('orders.create may not be carried by a service token');
      expect(error.message).toContain('accounts.manage may not be carried by a service token');
    });

    it('may carry only what the minter holds', async () => {
      const support = await person(UserRole.SUPPORT);
      const error = await refusal(
        service.mintServiceToken({
          actor: support,
          name: 'too much',
          permissions: [Permission.AUDIT_READ],
        }),
      );
      expect(error.message).toContain('audit.read is not something you hold');
    });

    it('end when revoked, and the audit row names who did it', async () => {
      const admin = await person(UserRole.ADMIN);
      const { token, secret } = await service.mintServiceToken({
        actor: admin,
        name: 'PropFA metrics',
        permissions: [Permission.ACCOUNTS_READ_ANY],
      });
      const revoked = await service.revokeServiceToken({
        actorId: admin.id,
        id: token.id,
        reason: 'Integration retired',
      });
      expect(revoked.status).toBe('REVOKED');
      expect((await refusal(service.authenticate(secret, TENANT, undefined))).message).toContain(
        'revoked',
      );
      const audited = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'service_token.revoked' },
      });
      expect(audited.actorId).toBe(admin.id);
      expect(JSON.stringify(audited.after)).toContain('Integration retired');
    });
  });

  describe('at the database', () => {
    it('holds a key to what it was minted as, and never deletes one', async () => {
      const trader = await person();
      const { key } = await mint(trader);
      await expect(
        prisma.apiKey.update({
          where: { id: key.id },
          data: { permissions: [Permission.ORDERS_CREATE, Permission.ACCOUNTS_READ_ANY] },
        }),
      ).rejects.toThrow(/minted as/);
      await expect(
        prisma.apiKey.update({
          where: { id: key.id },
          data: { expiresAt: new Date(Date.now() + 10 * 365 * 86_400_000) },
        }),
      ).rejects.toThrow(/minted as/);
      await expect(prisma.apiKey.delete({ where: { id: key.id } })).rejects.toThrow(
        /never deleted/,
      );
      // The display name and use are the holder's to change.
      await expect(
        prisma.apiKey.update({ where: { id: key.id }, data: { name: 'renamed' } }),
      ).resolves.toMatchObject({ name: 'renamed' });
    });
  });
});
