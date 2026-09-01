/**
 * Kept as a re-export so the seed, the harnesses and the pentest script need no
 * churn. The implementation moved into `@tp/tenancy` because the API needs it
 * too, and `apps/api` compiles with a `rootDir` that cannot reach out of its own
 * source tree — a boundary worth respecting rather than widening.
 */
export { seedTenantRoles, type SeedRolesResult } from '@tp/tenancy';
