import { cpus } from 'node:os';

/**
 * How many database connections one process may open, against how many the
 * server will give it.
 *
 * ## Why this exists
 *
 * A connection belongs to one tenant for its life, so there is a pool per
 * tenant, and `DATABASE_TENANT_POOLS` caps how many pools stay open. The
 * number of *connections* that implies is that cap times Prisma's
 * `connection_limit`, plus the two pools every process holds regardless (the
 * privileged owner and the unscoped one) — and nothing in the platform said so
 * at boot. The load harness found out the hard way: two instances against a
 * database holding thirty-five tenants asked for 340 connections from a server
 * configured for 100. Role reconciliation failed for some tenants, the price
 * alert sweep failed, and a trader registering was told `INTERNAL_ERROR`.
 *
 * None of that was a bug in what the platform does with a connection. It was
 * a budget nobody had written down, exceeded silently. So the budget is
 * computed here, once, and compared with what the server reports. When it
 * does not fit, the process says exactly what it may ask for, what the server
 * allows, and which two knobs change it.
 *
 * ## Why a warning and not a refusal
 *
 * The budget is a ceiling, not a demand: a deployment with one tenant never
 * opens more than three pools however high the cap is set. Refusing to start
 * would take a working deployment down over a limit it never reaches. The
 * warning is loud and once, at boot, where an operator reading the log after
 * a deploy will see it.
 */

/**
 * Prisma's default pool size when the URL does not say:
 * `num_physical_cpus * 2 + 1`. Node reports logical CPUs, which is what Prisma
 * uses too.
 */
export function defaultConnectionLimit(cpuCount: number = cpus().length): number {
  return cpuCount * 2 + 1;
}

/** `connection_limit` as the URL states it, or Prisma's default when it does not. */
export function connectionLimitOf(url: string, cpuCount?: number): number {
  const query = url.indexOf('?');
  if (query === -1) return defaultConnectionLimit(cpuCount);
  const raw = new URLSearchParams(url.slice(query + 1)).get('connection_limit');
  if (raw === null) return defaultConnectionLimit(cpuCount);
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultConnectionLimit(cpuCount);
}

export interface ConnectionBudgetInput {
  /** `DATABASE_TENANT_POOLS`. */
  readonly tenantPools: number;
  /** `connection_limit` on the tenant URL. */
  readonly tenantConnectionLimit: number;
  /** `connection_limit` on the owner URL, which also serves the unscoped pool. */
  readonly privilegedConnectionLimit: number;
}

export interface ServerCapacity {
  /** `max_connections`. */
  readonly maxConnections: number;
  /** `superuser_reserved_connections` — slots an application role never gets. */
  readonly reserved: number;
}

export interface ConnectionBudget {
  /** The most connections this one process may hold open at once. */
  readonly perInstance: number;
  /** What the server will give application roles in total. */
  readonly available: number;
  /** How many such instances fit side by side; 0 means not even one. */
  readonly instancesThatFit: number;
  readonly fits: boolean;
}

export function connectionBudget(
  input: ConnectionBudgetInput,
  server: ServerCapacity,
): ConnectionBudget {
  // Tenant pools, plus the unscoped pool (tenant role) and the privileged pool
  // (owner role). The unscoped one is sized by the tenant URL because it is
  // opened from it.
  const perInstance =
    (input.tenantPools + 1) * input.tenantConnectionLimit + input.privilegedConnectionLimit;
  const available = Math.max(0, server.maxConnections - server.reserved);
  const instancesThatFit = perInstance > 0 ? Math.floor(available / perInstance) : 0;
  return { perInstance, available, instancesThatFit, fits: instancesThatFit >= 1 };
}

/** One paragraph for the boot log, in the operator's terms. */
export function describeConnectionBudget(
  budget: ConnectionBudget,
  input: ConnectionBudgetInput,
): string {
  const head =
    `This instance may open up to ${budget.perInstance} database connections ` +
    `(${input.tenantPools} tenant pools + 1 unscoped, ${input.tenantConnectionLimit} each; ` +
    `1 privileged pool of ${input.privilegedConnectionLimit}); the server allows ${budget.available} ` +
    `for application roles. A pool evicted at the cap keeps its connections through the drain ` +
    `period, so a burst across more tenants than the cap can briefly exceed this.`;
  if (!budget.fits) {
    return (
      `${head} That does not fit even one instance: under enough tenants, queries will fail with ` +
      `"too many clients". Lower DATABASE_TENANT_POOLS or connection_limit on DATABASE_URL / ` +
      `DATABASE_URL_TENANT, or raise max_connections on the server.`
    );
  }
  return (
    `${head} ${budget.instancesThatFit} such instance(s) fit side by side` +
    (budget.instancesThatFit === 1
      ? ' — a second instance, the worker, or a migration job would compete for the same slots.'
      : '.')
  );
}
