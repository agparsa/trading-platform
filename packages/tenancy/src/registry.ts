import { isCrossTenant, type CrossTenantScope, type TenantContext } from './context';
import { tenantConnectionUrl } from './connection';

/**
 * The registry that decides which database connection a unit of work gets.
 *
 * ## Why there is more than one connection pool
 *
 * Row-level security has to be told which tenant is asking, and the only way to
 * tell it that costs nothing is to bind the tenant to the connection when the
 * connection is opened — see `connection.ts` for the measurements behind that.
 * A connection therefore belongs to one tenant for its lifetime, so there is a
 * pool per tenant.
 *
 * ## Three kinds of client, and why the default is the deaf one
 *
 *   - **A tenant's client** — the unprivileged role, `app.tenant_id` bound.
 *     Sees exactly that tenant's rows, including through `$queryRaw`, which is
 *     the hole the Prisma extension cannot reach.
 *   - **The unscoped client** — the same unprivileged role with no tenant bound.
 *     `current_tenant_id()` is NULL, NULL matches no row, so every tenant table
 *     reads empty. This is what work with no scope gets, deliberately: code that
 *     forgot to open a scope reads *nothing* rather than *everything*.
 *   - **The privileged client** — the owner role, exempt from its own policies.
 *     Reached only through `withoutTenantScope(reason)`, which is greppable and
 *     takes a reason for exactly this purpose.
 *
 * The ordering matters. If a missing scope fell through to the privileged
 * client, then forgetting to open a scope would silently disable both layers of
 * isolation at once, and nothing would look wrong.
 *
 * ## Eviction, and the query it must not kill
 *
 * `$disconnect()` does not drain: a query in flight when it is called fails,
 * with an empty error message, about as unhelpfully as an error can arrive.
 * That was measured, not assumed.
 *
 * So an evicted client is removed from the map immediately — no new work reaches
 * it — and disconnected only after `drainMs`, which is configured to exceed the
 * transaction timeout. Anything still running by then was already going to be
 * killed by the transaction budget.
 */

export interface Disconnectable {
  $disconnect(): Promise<void>;
}

export interface TenantClientRegistryOptions<C extends Disconnectable> {
  /** Connection URL for the unprivileged role that row-level security constrains. */
  readonly tenantUrl: string;
  /** Connection URL for the owner role, used only for deliberate cross-tenant work. */
  readonly privilegedUrl: string;
  /** Builds a client for a URL. Injected so this package needs no Prisma import. */
  readonly createClient: (url: string) => C;
  /** How many tenant clients may be live at once. */
  readonly maxClients?: number;
  /** How long an evicted client keeps serving work already in flight. */
  readonly drainMs?: number;
  readonly onEvict?: (tenantId: string) => void;
  readonly onDisconnectError?: (tenantId: string, error: unknown) => void;
}

/** Well above `DATABASE_TRANSACTION_TIMEOUT_MS`, whose default is 15s. */
const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_MAX_CLIENTS = 32;

export class TenantClientRegistry<C extends Disconnectable> {
  /** Insertion order is recency: a hit deletes and re-sets, so the first entry is the LRU. */
  private readonly tenants = new Map<string, C>();
  private privileged: C | undefined;
  private unscoped: C | undefined;
  private readonly draining = new Set<ReturnType<typeof setTimeout>>();
  private readonly maxClients: number;
  private readonly drainMs: number;

  constructor(private readonly options: TenantClientRegistryOptions<C>) {
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
    if (this.maxClients < 1) throw new Error('maxClients must be at least 1');
  }

  /** The client for a scope. `undefined` means no scope, which reads nothing. */
  forScope(scope: TenantContext | CrossTenantScope | undefined): C {
    if (scope === undefined) return this.unscopedClient();
    if (isCrossTenant(scope)) return this.privilegedClient();
    return this.forTenant(scope.tenantId);
  }

  forTenant(tenantId: string): C {
    const existing = this.tenants.get(tenantId);
    if (existing !== undefined) {
      // Re-insert to mark it most recently used.
      this.tenants.delete(tenantId);
      this.tenants.set(tenantId, existing);
      return existing;
    }

    // `tenantConnectionUrl` validates the id before it reaches the URL. It runs
    // first so a bad id never causes an eviction.
    const client = this.options.createClient(tenantConnectionUrl(this.options.tenantUrl, tenantId));

    while (this.tenants.size >= this.maxClients) {
      const oldest = this.tenants.keys().next();
      if (oldest.done === true) break;
      this.evict(oldest.value);
    }

    this.tenants.set(tenantId, client);
    return client;
  }

  privilegedClient(): C {
    this.privileged ??= this.options.createClient(this.options.privilegedUrl);
    return this.privileged;
  }

  unscopedClient(): C {
    this.unscoped ??= this.options.createClient(this.options.tenantUrl);
    return this.unscoped;
  }

  /** Live tenant clients, most recently used last. For tests and metrics. */
  get size(): number {
    return this.tenants.size;
  }

  private evict(tenantId: string): void {
    const client = this.tenants.get(tenantId);
    if (client === undefined) return;
    this.tenants.delete(tenantId);
    this.options.onEvict?.(tenantId);

    const timer = setTimeout(() => {
      this.draining.delete(timer);
      void client.$disconnect().catch((error: unknown) => {
        this.options.onDisconnectError?.(tenantId, error);
      });
    }, this.drainMs);
    // A drain must never be the reason a process refuses to exit.
    timer.unref?.();
    this.draining.add(timer);
  }

  /**
   * Closes everything, without waiting out the drain — shutdown is already the
   * moment when in-flight work is ending.
   */
  async disconnectAll(): Promise<void> {
    for (const timer of this.draining) clearTimeout(timer);
    this.draining.clear();

    const clients = [...this.tenants.values(), this.privileged, this.unscoped].filter(
      (client): client is C => client !== undefined,
    );
    this.tenants.clear();
    this.privileged = undefined;
    this.unscoped = undefined;

    await Promise.allSettled(clients.map((client) => client.$disconnect()));
  }
}
