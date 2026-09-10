import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withoutTenantScope } from '@tp/tenancy';
import { RolesService } from '../../src/permissions/roles.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  TEST_DATABASE_URL,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Boot-time role reconciliation, and what it costs in connections.
 *
 * A connection is bound to one tenant for its life, so a pool per tenant is how
 * tenancy is enforced at the database — and `DATABASE_TENANT_POOLS` caps how
 * many of those pools stay routable, not how many are connected: an evicted
 * pool keeps its connections through a drain period. Reconciliation used to
 * enter every tenant's scope in turn, so booting against a database with more
 * tenants than the cap opened a pool for each of them within a second. Two
 * instances did that against a stock Postgres and ran it out of connections;
 * the load harness found it.
 *
 * This pins the fix: the sweep is platform work and runs through the single
 * privileged pool, and boot opens no tenant pool at all.
 */
suite('role reconciliation at boot', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    await resetDatabase(prisma);
    const values: Record<string, unknown> = {
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_TENANT_POOLS: 2,
      DATABASE_TRANSACTION_TIMEOUT_MS: 20_000,
      DATABASE_TRANSACTION_MAX_WAIT_MS: 10_000,
    };
    prismaService = new PrismaService({ get: (key: string) => values[key] } as never);
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
    await prisma.$disconnect();
  });

  it('reconciles more tenants than the pool cap without opening a tenant pool', async () => {
    // Six tenants against a cap of two. Half of them lose a role, so the sweep
    // reads *and* writes through whatever connection it chooses.
    const tenantIds: string[] = [];
    for (let i = 0; i < 6; i += 1) tenantIds.push(await createTenant(prisma, `recon-${i}`));
    for (const tenantId of tenantIds.slice(0, 3)) {
      await withoutTenantScope('test setup removes a role so reconciliation has work', () =>
        prisma.role.deleteMany({ where: { tenantId, key: 'USER' } }),
      );
    }

    const redis = {
      subscriber: { subscribe: async () => undefined, on: () => undefined },
      publisher: { publish: async () => 0 },
    };
    const audit = { record: async () => undefined };
    const service = new RolesService(prismaService, redis as never, audit as never);

    expect(prismaService.tenantPoolsOpen).toBe(0);
    await service.onModuleInit();
    expect(prismaService.tenantPoolsOpen).toBe(0);

    // And the work was done: every tenant has its USER role back.
    for (const tenantId of tenantIds) {
      const role = await withoutTenantScope('test reads every tenant', () =>
        prisma.role.findFirst({ where: { tenantId, key: 'USER' } }),
      );
      expect(role, `tenant ${tenantId} has a USER role after reconciliation`).not.toBeNull();
    }
  });
});
