import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant the current unit of work belongs to.
 *
 * There are exactly four places this is set, and adding a fifth should take an
 * argument:
 *
 *   1. `JwtAuthGuard`, from the `tid` claim in the access token.
 *   2. `TenantHostMiddleware`, from the hostname, for the handful of routes
 *      that run before anybody is authenticated.
 *   3. The realtime gateway, on connection, from the same claim.
 *   4. The worker, explicitly, once per tenant as it iterates.
 *
 * It is deliberately not settable from a header, a body field, a query
 * parameter or a path segment. A client that can name its own tenant can name
 * somebody else's, and at that point the boundary is decorative.
 */

export interface TenantContext {
  readonly tenantId: string;
  /** For log lines and error messages. Never used to decide anything. */
  readonly slug: string;
}

/**
 * A deliberate, named crossing of the boundary.
 *
 * `reason` is not decoration: it is what a reviewer reads when they grep for
 * every place tenancy is bypassed, and a bypass whose reason is "needed it" is
 * one worth arguing about.
 */
export interface CrossTenantScope {
  readonly crossTenant: true;
  readonly reason: string;
}

type Scope = TenantContext | CrossTenantScope;

const storage = new AsyncLocalStorage<Scope>();

export function isCrossTenant(scope: Scope | undefined): scope is CrossTenantScope {
  return scope !== undefined && 'crossTenant' in scope;
}

/**
 * Runs `fn` with this tenant in scope, and keeps the scope until it settles.
 *
 * ## Why this is not simply `storage.run(context, fn)`
 *
 * Prisma's query objects are **lazy thenables**: `prisma.account.findMany()`
 * builds a request and starts nothing. The query runs when something calls
 * `.then` on it.
 *
 * So `storage.run(ctx, () => prisma.account.findMany())` does the wrong thing
 * in a way that is almost impossible to see. `run` calls the callback
 * synchronously, gets the un-started thenable back, and returns — restoring the
 * previous scope. The caller then awaits it, and *that* is when the query runs:
 * outside the scope it was supposed to be inside.
 *
 * The symptom is a query silently answered for the wrong tenant, and it cost an
 * afternoon: an isolation test where one tenant's read returned another's row,
 * while a probe of the same mechanism with an `async` callback passed.
 *
 * Awaiting inside the run is the fix. `fn()` is still called synchronously, so
 * a callback like `next()` in middleware still runs in scope; and the `await`
 * means a returned thenable is started in scope too.
 */
export async function withTenant<T>(context: TenantContext, fn: () => T | Promise<T>): Promise<T> {
  return storage.run(context, async () => fn());
}

/**
 * Runs `fn` with tenancy switched off.
 *
 * Legitimate callers, and there are not many:
 *
 *   - the sign-in lookup, which has to find a user before it knows their tenant
 *   - reconciliation and other work that sweeps every tenant in turn
 *   - the tenant resolver itself, which reads the `tenants` table
 *   - migrations and seeds
 *
 * Anything else is almost certainly a bug wearing a disguise. This is the call
 * to grep for when asking "where can data cross tenants?", which is why it
 * takes a reason and why the reason is a required argument rather than an
 * optional one.
 */
export async function withoutTenantScope<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  // Async for the same reason as `withTenant` — see the note there about
  // Prisma's lazy thenables.
  return storage.run({ crossTenant: true, reason }, async () => fn());
}

/**
 * Enters a tenant scope for the rest of the current execution context.
 *
 * `withTenant` wraps a function and is what request handling uses, because the
 * scope then ends exactly where the request does. `enterWith` has no such
 * boundary: once called, everything downstream in this async context sees the
 * tenant until the context ends.
 *
 * That is wrong for a request and right for two other things:
 *
 *   - a process-level entry point, such as a worker job that runs for one
 *     tenant and then exits;
 *   - a test's `beforeEach`, where wrapping the test body is not possible.
 *
 * Do not reach for this inside a request handler. If a handler needs to change
 * tenant mid-flight, something upstream is wrong.
 */
export function enterTenantScope(context: TenantContext): void {
  storage.enterWith(context);
}

/** The current tenant, or undefined outside any scope. */
export function currentTenant(): TenantContext | undefined {
  const scope = storage.getStore();
  return scope === undefined || isCrossTenant(scope) ? undefined : scope;
}

/** The raw scope, including a cross-tenant marker. For the Prisma extension. */
export function currentScope(): Scope | undefined {
  return storage.getStore();
}

/**
 * The current tenant id, or a thrown error.
 *
 * For code that cannot proceed without one and would otherwise quietly operate
 * on nothing. Throwing beats returning undefined here: a filter of
 * `tenantId: undefined` is not a filter at all, and Prisma will happily run it.
 */
export function requireTenantId(): string {
  const tenant = currentTenant();
  if (tenant === undefined) {
    throw new Error(
      'No tenant in scope. Every request carries one; work that legitimately spans tenants must say so with withoutTenantScope().',
    );
  }
  return tenant.tenantId;
}

/**
 * Runs `fn` outside every scope — the state a process entry point starts in.
 *
 * Exists for one reason: to prove that something opens its own scope. A test
 * harness enters a tenant in `beforeEach` so that ordinary tests can write
 * rows, and that is exactly what hid a job which never opened one — every
 * test drove it from inside a scope the harness had opened, and in production,
 * where a queue hands a job nothing, its first write was refused. Five times,
 * on schedule, for weeks.
 *
 * It cannot widen anything: outside a scope the extension refuses every
 * scoped query, so the only thing this can do to code that is correct is
 * nothing.
 */
export async function outsideAnyScope<T>(fn: () => T | Promise<T>): Promise<T> {
  return storage.exit(async () => fn());
}
