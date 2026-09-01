/**
 * Tenant isolation, shared by every process that opens the database.
 *
 * It lives in a package rather than in `apps/api` because the worker needs the
 * same scope and the same extension, and two copies of an isolation boundary is
 * one copy that will one day be a version behind.
 *
 * The parts that are HTTP-shaped — resolving a tenant from a hostname, the Nest
 * middleware that opens the scope for a request — stay in the API, because they
 * are about requests rather than about tenancy.
 */
export {
  type TenantContext,
  type CrossTenantScope,
  withTenant,
  withoutTenantScope,
  enterTenantScope,
  currentTenant,
  currentScope,
  isCrossTenant,
  requireTenantId,
} from './context';
export { tenantScopeExtension, TENANT_SCOPED_MODELS, DELIBERATELY_UNSCOPED_MODELS } from './scope';
export { tenantConnectionUrl, TENANT_SETTING } from './connection';
export { probeTenantIsolation, type IsolationState, type RawQueryable } from './probe';
export {
  TenantClientRegistry,
  type Disconnectable,
  type TenantClientRegistryOptions,
} from './registry';
