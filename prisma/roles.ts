import type { PrismaClient } from '@prisma/client';
import { seedRoles } from '@tp/shared-types';

export interface SeedRolesResult {
  /** Roles that did not exist and were created. */
  readonly created: number;
  /** Built-in roles nobody has edited, brought back in line with this build. */
  readonly refreshed: number;
}

/**
 * Writes a tenant's roles, from the same constants the API seeds from.
 *
 * A plain function rather than a Nest service because four callers need it and
 * only one of them has an injector: the API's `RolesService`, this database
 * seed, the integration harnesses, and the pentest script. It takes a client so
 * it can run inside whatever scope the caller already has.
 *
 * ## Why it does two different things
 *
 * A missing role is created. That much was always true.
 *
 * A built-in role that **nobody has edited** is also brought back in line with
 * this build — added capabilities included. Grants became rows so a firm could
 * change them without a deployment, and that made the reverse case a problem
 * nobody had yet: a release adding `wallet.read` to the trader role could not
 * reach an existing tenant, so the new feature worked in the tests and answered
 * 403 in production. That is not hypothetical; it is how the wallet phase's own
 * pentest probe failed.
 *
 * A role somebody **has** edited is left exactly as they left it. `grantsEditedAt`
 * is what tells the two apart, and the asymmetry is deliberate: a deploy that
 * silently re-widened a role an operator had narrowed would be the worst kind of
 * regression, because nothing about it would look wrong.
 */
export async function seedTenantRoles(
  prisma: PrismaClient,
  tenantId: string,
): Promise<SeedRolesResult> {
  let created = 0;
  let refreshed = 0;

  for (const role of seedRoles()) {
    const existing = await prisma.role.findFirst({
      where: { tenantId, key: role.key },
      select: { id: true, isSystem: true, grantsEditedAt: true },
    });

    if (existing === null) {
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
      continue;
    }

    if (!existing.isSystem || existing.grantsEditedAt !== null) continue;

    const held = await prisma.rolePermission.findMany({
      where: { roleId: existing.id },
      select: { permission: true },
    });
    const before = new Set(held.map((grant) => grant.permission));
    const shipped = new Set<string>(role.permissions);
    const same = before.size === shipped.size && [...shipped].every((one) => before.has(one));
    if (same) continue;

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: existing.id } });
      await tx.rolePermission.createMany({
        data: role.permissions.map((permission) => ({
          tenantId,
          roleId: existing.id,
          permission,
        })),
      });
    });
    refreshed += 1;
  }

  return { created, refreshed };
}
