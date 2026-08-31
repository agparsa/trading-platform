import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withTenant, withoutTenantScope } from '../../src/tenancy/tenant-context';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * What "isolation" is tested to mean.
 *
 * Two tenants, each with a user and an account, and then every question one
 * could ask about the other's data. The assertion that matters throughout is
 * **not-found rather than forbidden**: a forbidden confirms the row exists,
 * which turns an isolation boundary into an oracle for enumerating ids.
 */
suite('Tenant isolation (integration)', () => {
  let prisma: PrismaClient;

  const alpha = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };
  let beta: { tenantId: string; slug: string };
  let alphaAccount: { userId: string; accountId: string };
  let betaAccount: { userId: string; accountId: string };

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const betaId = await createTenant(prisma, 'beta', 'beta.example.test');
    beta = { tenantId: betaId, slug: 'beta' };

    alphaAccount = await createAccount(prisma, { balance: '1000', email: 'a@alpha.test' });
    betaAccount = await withTenant(beta, () =>
      createAccount(prisma, { balance: '2000', email: 'b@beta.test', tenantId: betaId }),
    );
  });

  describe('reads', () => {
    it('does not list another tenant’s accounts', async () => {
      const mine = await prisma.account.findMany();
      expect(mine.map((a) => a.id)).toEqual([alphaAccount.accountId]);

      const theirs = await withTenant(beta, () => prisma.account.findMany());
      expect(theirs.map((a) => a.id)).toEqual([betaAccount.accountId]);
    });

    it('answers not-found for another tenant’s account by id', async () => {
      /**
       * By id, which is the interesting case: the caller already has the
       * identifier, so anything other than "no such row" tells them it is real.
       */
      const found = await prisma.account.findFirst({ where: { id: betaAccount.accountId } });
      expect(found).toBeNull();

      await expect(
        prisma.account.findFirstOrThrow({ where: { id: betaAccount.accountId } }),
      ).rejects.toThrow();
    });

    it('does not find another tenant’s user by email', async () => {
      expect(await prisma.user.findFirst({ where: { email: 'b@beta.test' } })).toBeNull();
    });

    it('does not count another tenant’s rows', async () => {
      expect(await prisma.account.count()).toBe(1);
      expect(await withTenant(beta, () => prisma.account.count())).toBe(1);
    });

    it('does not reach another tenant’s ledger, orders, positions or notifications', async () => {
      for (const query of [
        () => prisma.balanceLedger.findMany({ where: { accountId: betaAccount.accountId } }),
        () => prisma.order.findMany({ where: { accountId: betaAccount.accountId } }),
        () => prisma.position.findMany({ where: { accountId: betaAccount.accountId } }),
        () => prisma.notification.findMany({ where: { userId: betaAccount.userId } }),
        () => prisma.auditLog.findMany({ where: { actorId: betaAccount.userId } }),
      ]) {
        expect(await query()).toEqual([]);
      }
    });

    it('gives beta its own ledger, so the emptiness above is isolation and not an empty database', async () => {
      const entries = await withTenant(beta, () =>
        prisma.balanceLedger.findMany({ where: { accountId: betaAccount.accountId } }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.amount.toString()).toBe('2000');
    });
  });

  describe('writes', () => {
    it('cannot update another tenant’s account', async () => {
      const changed = await prisma.account.updateMany({
        where: { id: betaAccount.accountId },
        data: { leverage: 500 },
      });
      expect(changed.count).toBe(0);

      const untouched = await withTenant(beta, () =>
        prisma.account.findUniqueOrThrow({ where: { id: betaAccount.accountId } }),
      );
      expect(untouched.leverage).not.toBe(500);
    });

    it('cannot delete another tenant’s rows', async () => {
      const deleted = await prisma.notification.deleteMany({
        where: { userId: betaAccount.userId },
      });
      expect(deleted.count).toBe(0);
    });

    it('refuses a row written for a tenant that is not in scope', async () => {
      /**
       * The one case TypeScript cannot catch: a service holding an id from
       * somewhere else and passing it instead of the ambient one. Overwriting it
       * would hide the bug; throwing surfaces it.
       */
      await expect(
        prisma.riskRuleConfig.create({
          data: { tenantId: beta.tenantId, name: 'smuggled', parameters: {} },
        }),
      ).rejects.toThrow(/while .* is in scope/);
    });

    it('stamps a create with the tenant in scope, not the one in the payload’s absence', async () => {
      const rule = await prisma.riskRuleConfig.create({
        data: { tenantId: alpha.tenantId, name: 'mine', parameters: {} },
      });
      expect(rule.tenantId).toBe(alpha.tenantId);
      expect(await withTenant(beta, () => prisma.riskRuleConfig.findMany())).toEqual([]);
    });

    it('lets two tenants use the same account number and the same email', async () => {
      // The whole reason those uniques became composite. If this fails, the
      // second firm to sign a customer cannot sign them.
      const shared = 'same-person@example.test';
      await prisma.user.create({
        data: { tenantId: alpha.tenantId, email: shared, passwordHash: 'x', displayName: 'A' },
      });
      await expect(
        withTenant(beta, () =>
          prisma.user.create({
            data: { tenantId: beta.tenantId, email: shared, passwordHash: 'x', displayName: 'B' },
          }),
        ),
      ).resolves.toMatchObject({ email: shared });
    });
  });

  describe('the scope itself', () => {
    it('lets deliberate cross-tenant work through, and says so in one place', async () => {
      const everything = await withoutTenantScope('isolation test: sweeping every tenant', () =>
        prisma.account.findMany(),
      );
      expect(everything).toHaveLength(2);
    });
  });
});
