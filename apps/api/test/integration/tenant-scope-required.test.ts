import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { tenantScopeExtension, withoutTenantScope } from '@tp/tenancy';
import { TEST_DATABASE_URL, hasTestDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * A file of its own, deliberately, because of what it must *not* do.
 *
 * Every other integration suite calls `resetDatabase`, which puts a tenant in
 * scope — so none of them can check what happens when there is none. This one
 * never enters a scope, which is the only way to assert the behaviour that
 * matters most: **forgetting is a crash, not a leak.**
 *
 * If this test ever starts failing because "there is no tenant" stopped being
 * an error, the thing that broke is the entire isolation guarantee, and every
 * query in the platform silently reads across every customer.
 */
suite('a query with no tenant in scope', () => {
  const prisma = hasTestDatabase
    ? new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }).$extends(
        tenantScopeExtension(),
      )
    : null;

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('refuses a read', async () => {
    await expect(prisma!.account.findMany()).rejects.toThrow(/no tenant in scope/);
  });

  it('refuses a write', async () => {
    await expect(
      prisma!.riskRuleConfig.create({
        data: { tenantId: '00000000-0000-4000-8000-000000000000', name: 'x', parameters: {} },
      }),
    ).rejects.toThrow(/no tenant in scope/);
  });

  it('refuses a count, which is the read that looks harmless', async () => {
    // A count leaks less than a list and still leaks: "how many customers does
    // this firm have" is a number somebody would pay for.
    await expect(prisma!.user.count()).rejects.toThrow(/no tenant in scope/);
  });

  it('names the model and the operation, so the fix is obvious from the message', async () => {
    await expect(prisma!.order.findFirst()).rejects.toThrow(/Order\.findFirst/);
  });

  it('leaves global models alone — an instrument belongs to nobody', async () => {
    await expect(prisma!.symbol.findMany()).resolves.toBeInstanceOf(Array);
  });

  it('lets deliberate cross-tenant work through when it says so', async () => {
    const rows = await withoutTenantScope('test: the escape hatch works', () =>
      prisma!.account.findMany({ take: 1 }),
    );
    expect(rows).toBeInstanceOf(Array);
  });
});
