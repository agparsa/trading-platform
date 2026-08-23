import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@tp/shared-types';

export const ROLES_KEY = 'tp:roles';

/** Restrict a route to the listed roles. Absent means any authenticated user. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
