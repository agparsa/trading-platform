import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The complete set the role should carry afterwards.
 *
 * A whole set rather than add/remove, because two administrators editing the
 * same role at once should not silently merge into a union nobody chose.
 *
 * Only shape is checked here: that it is a bounded list of short strings.
 * Whether each name is a capability this build defines, whether the editor holds
 * it, and whether the combination is one no single role may hold are decided in
 * `RolesService`, inside the transaction that records the change. Answering them
 * here would put the answer outside that transaction and give a second caller a
 * way to reach the write without them.
 */
export const setRolePermissionsSchema = z
  .object({
    permissions: z.array(z.string().trim().min(1).max(64)).max(200),
  })
  .strict();

export class SetRolePermissionsDto extends createZodDto(setRolePermissionsSchema) {}
