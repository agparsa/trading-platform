import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { probeTenantIsolation } from '@tp/tenancy';
import { createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The probe's answer changes without a restart, and nothing used to ask again.
 *
 * This is the defect measured against a real database rather than argued. The
 * probe reads `users` — chosen, in its own comment, because that table "is
 * never empty in a running deployment". It is empty at exactly one moment: a
 * fresh install starting for the first time, which was the only moment anything
 * asked.
 */
suite('the isolation probe on a real database', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const probe = () => probeTenantIsolation(prisma, prisma);

  it('answers unknown on a fresh install and definitely a minute later, on the same connection', async () => {
    const atBoot = await probe();
    expect(atBoot.enforced, 'an empty users table cannot prove anything either way').toBe(
      'unknown',
    );

    // One registration. Nothing else about the deployment changes: same
    // process, same connection, same role, same policies.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
       VALUES (gen_random_uuid(),'probe-firm','Probe Firm','ACTIVE',now(),now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, display_name, role, email_verified,
                          is_active, failed_login_attempts, created_at, updated_at, tenant_id)
       VALUES (gen_random_uuid(),'first@probe.test','x','First','USER',true,true,0,now(),now(),
               (SELECT id FROM tenants WHERE slug = 'probe-firm'))`,
    );

    const afterFirstUser = await probe();
    expect(afterFirstUser.enforced, 'the same question now has an answer').not.toBe('unknown');

    /**
     * The test suite connects as the owner, which row-level security exempts,
     * so the definite answer here is `false`. That is the point: on a two-role
     * deployment this is the moment the misconfiguration the platform promises
     * to refuse becomes detectable — and before this phase, nothing asked.
     */
    expect(afterFirstUser.enforced).toBe(false);
    expect(afterFirstUser).toHaveProperty('reason', expect.stringContaining('users'));
  });
});
