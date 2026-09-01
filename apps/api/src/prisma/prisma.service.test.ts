import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from './prisma.service';

/**
 * `PrismaService` returns a proxy from its constructor, so that the only client
 * anybody can reach is one bound to the tenant currently in scope.
 *
 * That is an unusual construction and it can break silently on a Prisma or Nest
 * upgrade in two different directions. Either the class's own members stop being
 * reachable — the first symptom would be Nest never calling `onModuleInit`, at
 * boot, in production — or the routing stops routing, and every tenant quietly
 * shares one connection again with no error anywhere.
 *
 * Nothing here opens a connection. Prisma builds a client without connecting, so
 * *which* client answers is observable long before any query is sent.
 */
const ALPHA = { tenantId: '11111111-1111-1111-1111-111111111111', slug: 'alpha' };
const BETA = { tenantId: '22222222-2222-2222-2222-222222222222', slug: 'beta' };

function service(): PrismaService {
  const config = new ConfigService<Record<string, unknown>, true>({
    DATABASE_URL: 'postgresql://owner:pw@localhost:5432/trading?schema=public',
    DATABASE_URL_TENANT: 'postgresql://app:pw@localhost:5432/trading?schema=public',
    DATABASE_TENANT_POOLS: 8,
    DATABASE_TRANSACTION_TIMEOUT_MS: 15_000,
    DATABASE_TRANSACTION_MAX_WAIT_MS: 5_000,
  } as never);
  return new PrismaService(config as never);
}

describe('PrismaService', () => {
  it('keeps the class members Nest and the health check depend on', () => {
    const prisma = service();

    expect(typeof prisma.onModuleInit).toBe('function');
    expect(typeof prisma.onModuleDestroy).toBe('function');
    expect(typeof prisma.ping).toBe('function');
  });

  it('keeps the client members the application depends on', () => {
    const prisma = service();

    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
    expect(typeof prisma.$transaction).toBe('function');
    expect(typeof prisma.$queryRaw).toBe('function');
  });

  it('exposes the models', () => {
    const prisma = service();

    expect(typeof prisma.user.findFirst).toBe('function');
    expect(typeof prisma.account.findFirst).toBe('function');
    expect(typeof prisma.tenant.findFirst).toBe('function');
  });

  it('answers two tenants from two different connections', async () => {
    const prisma = service();

    const alpha = await withTenant(ALPHA, () => prisma.user);
    const beta = await withTenant(BETA, () => prisma.user);

    expect(alpha).not.toBe(beta);
  });

  it('answers the same tenant from the same connection', async () => {
    const prisma = service();

    const first = await withTenant(ALPHA, () => prisma.user);
    const second = await withTenant(ALPHA, () => prisma.user);

    expect(first).toBe(second);
  });

  /**
   * The three-way split, from the outside. Cross-tenant work is the only thing
   * that reaches the privileged connection; work with no scope at all reaches
   * the one that can read nothing, so forgetting to open a scope fails closed.
   */
  it('sends cross-tenant work somewhere no tenant goes', async () => {
    const prisma = service();

    const cross = await withoutTenantScope('a sweep', () => prisma.user);
    const unscoped = prisma.user;
    const alpha = await withTenant(ALPHA, () => prisma.user);

    expect(cross).not.toBe(unscoped);
    expect(cross).not.toBe(alpha);
    expect(unscoped).not.toBe(alpha);
  });

  it('refuses a tenant id that is not a UUID rather than falling back to a shared connection', async () => {
    const prisma = service();

    await expect(
      withTenant({ tenantId: 'alpha -c role=postgres', slug: 'x' }, () => prisma.user),
    ).rejects.toThrow(/not a UUID/);
  });

  it('starts out reporting that it has not checked whether isolation is enforced', () => {
    // Not `enforced: false`, which would be a claim; not `true`, which would be
    // a lie until `onModuleInit` has asked the database.
    expect(service().isolation.enforced).toBe('unknown');
  });
});
