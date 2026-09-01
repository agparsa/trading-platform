import type { PrismaClient } from '@prisma/client';
import { seedRoles } from '@tp/shared-types';

/**
 * Writes a tenant's roles, from the same constants the API seeds from.
 *
 * A plain function rather than a Nest service because four callers need it and
 * only one of them has an injector: the API's `RolesService`, this database
 * seed, the integration harnesses, and the pentest script. It takes a client so
 * it can run inside whatever scope the caller already has.
 *
 * Idempotent, and deliberately only *adds*. A tenant missing a role gets it; a
 * role whose grants an administrator narrowed keeps the narrowing, because a
 * seed that restored removed capabilities would quietly undo a deliberate
 * decision every time somebody redeployed.
 */
export async function seedTenantRoles(prisma: PrismaClient, tenantId: string): Promise<number> {
  let created = 0;
  for (const role of seedRoles()) {
    const existing = await prisma.role.findFirst({
      where: { tenantId, key: role.key },
      select: { id: true },
    });
    if (existing !== null) continue;
    await prisma.role.create({
      data: {
        tenantId,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
        permissions: { create: role.permissions.map((permission) => ({ tenantId, permission })) },
      },
    });
    created += 1;
  }
  return created;
}
