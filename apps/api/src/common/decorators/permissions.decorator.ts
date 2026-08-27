import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@tp/shared-types';

export const PERMISSIONS_KEY = 'tp:permissions';

/**
 * Declare what a route requires. Every listed permission must be held — this is
 * `and`, not `or`, because a route that needs two capabilities needs both.
 *
 * A route with no declaration is readable by any authenticated user. That is
 * deliberate for reads and dangerous for writes, so a test enumerates every
 * mutating route and fails if one has no declaration; see
 * `permissions-coverage.test.ts`.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
