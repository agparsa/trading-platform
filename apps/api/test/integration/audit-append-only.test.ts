import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { enterTenantScope } from '@tp/tenancy';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createTestClient,
  hasTestDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The audit log's guarantee, tested where it is actually made.
 *
 * Until the `audit_log_append_only` migration, nothing in the application
 * offered a way to edit or delete an audit row — which is a convention, and a
 * convention holds only for people who are following it. The specification
 * requires that a normal administrator cannot modify or delete audit records,
 * and an attacker who reaches the database is not a normal administrator but is
 * exactly who the requirement exists for.
 *
 * These tests bypass the application entirely and issue the statements
 * directly, because that is the threat.
 */
suite('audit_logs is append-only (integration)', () => {
  let prisma: PrismaClient;
  let id: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();

    /**
     * This suite deliberately does not call `resetDatabase` — it must not
     * truncate the very table it is checking cannot be truncated. So it enters
     * a tenant of its own, and upserts rather than creates, because the tenant
     * may already be there from another suite.
     */
    await prisma.tenant.upsert({
      where: { id: DEFAULT_TENANT_ID },
      create: { id: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, name: 'Test Tenant' },
      update: {},
    });
    enterTenantScope({ tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG });

    const row = await prisma.auditLog.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        actorType: 'SYSTEM',
        action: 'APPEND_ONLY_PROOF',
        resourceType: 'Test',
      },
    });
    id = row.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('accepts an insert', async () => {
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.action).toBe('APPEND_ONLY_PROOF');
  });

  it('refuses an update, and leaves the row as it was', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = '${id}'`),
    ).rejects.toThrow(/append-only/i);

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.action).toBe('APPEND_ONLY_PROOF');
  });

  it('refuses a delete, and leaves the row present', async () => {
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${id}'`),
    ).rejects.toThrow(/append-only/i);

    expect(await prisma.auditLog.findUnique({ where: { id } })).not.toBeNull();
  });

  it('refuses a truncate', async () => {
    /**
     * TRUNCATE does not fire row-level triggers. Without a statement-level
     * trigger of its own it would be the one statement that empties the table
     * while UPDATE and DELETE are refused — an unlocked back door beside two
     * locked front ones.
     */
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE audit_logs')).rejects.toThrow(
      /append-only/i,
    );

    expect(await prisma.auditLog.count()).toBeGreaterThan(0);
  });

  it('refuses a delete that names no row in particular', async () => {
    // The careless cleanup script, which is the likeliest way this table would
    // actually have been emptied.
    await expect(prisma.$executeRawUnsafe('DELETE FROM audit_logs')).rejects.toThrow(
      /append-only/i,
    );
  });

  it('reports a privilege error, so a caller can tell refusal from failure', async () => {
    // ERRCODE 42501 — insufficient_privilege. A generic error would look like a
    // transient fault and invite a retry loop.
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${id}'`),
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '42501' }) });
  });
});
