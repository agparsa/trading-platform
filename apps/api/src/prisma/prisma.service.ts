import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.schema';
import {
  TenantClientRegistry,
  currentScope,
  probeTenantIsolation,
  tenantScopeExtension,
  type IsolationState,
} from '@tp/tenancy';

/**
 * The database, routed by tenant.
 *
 * ## What changed and why
 *
 * There used to be one client. Every query went through the Prisma extension in
 * `@tp/tenancy`, which injects `tenantId` into filters — layer one — and
 * row-level security sat underneath as layer two, protecting against the three
 * things the extension cannot see: `$queryRaw`, a nested `connect`, and a model
 * missing from the scoped list.
 *
 * Layer two did not apply to the application. PostgreSQL exempts a table's owner
 * from its own policies, the application owned its tables, and so the backstop
 * backed up everyone except the process most able to make the mistake.
 *
 * Fixing that needs `app.tenant_id` set on every connection the application
 * uses, which is what `TenantClientRegistry` does: a pool per tenant, the tenant
 * bound in the connection's startup options. Measured cost: none — see
 * `packages/tenancy/src/connection.ts` for the numbers and the two slower
 * approaches they ruled out.
 *
 * ## Why this object is a proxy
 *
 * Because the alternative is to make every call site ask for a client first,
 * and the one that forgets gets the wrong tenant. `this.prisma.order.findMany()`
 * still reads exactly as it did; what changed is which connection answers it.
 *
 * `$transaction`, `$queryRaw` and every model delegate come from the client the
 * current scope resolves to, so a raw query inside a transaction is on the same
 * tenant-bound connection as the transaction — which is the whole point.
 */
/**
 * The service's own type is `PrismaClient` plus its own members, declared
 * rather than inherited.
 *
 * Extending `PrismaClient` would construct one — a whole query engine, on a
 * connection string chosen before any tenant is known, that nothing would ever
 * query. Declaration merging gives call sites the identical type without it.
 */
/*
 * `no-unsafe-declaration-merging` is disabled here rather than worked around,
 * and the rule is right about the risk: a merged interface promises members the
 * class does not implement, so the type can lie. What makes it true at runtime
 * is the proxy below — and because "the proxy still forwards everything" is an
 * assumption that a Prisma or Nest upgrade could quietly break, it is asserted
 * rather than assumed: `prisma.service.test.ts` checks that `$connect`,
 * `$transaction`, `$queryRaw` and the model delegates are all reachable, and
 * that the service's own members still are too.
 */
/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type */
export interface PrismaService extends PrismaClient {}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly registry: TenantClientRegistry<PrismaClient>;

  /** What the boot probe found. Exposed so the health endpoint can report it. */
  public isolation: IsolationState = {
    enforced: 'unknown',
    role: 'unknown',
    reason: 'not probed yet',
  };

  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>) {
    const owner = config.get('DATABASE_URL', { infer: true });
    const tenantUrl = config.get('DATABASE_URL_TENANT', { infer: true }) ?? owner;

    this.registry = new TenantClientRegistry<PrismaClient>({
      tenantUrl,
      privilegedUrl: owner,
      maxClients: config.get('DATABASE_TENANT_POOLS', { infer: true }),
      /**
       * Long enough that anything still running when a pool is evicted was
       * already past the transaction budget. `$disconnect()` does not drain —
       * a query in flight when it is called fails with an empty message.
       */
      drainMs: config.get('DATABASE_TRANSACTION_TIMEOUT_MS', { infer: true }) * 2,
      createClient: (url) => this.createClient(url),
      onEvict: (tenantId) =>
        this.logger.log(
          `Evicted the connection pool for tenant ${tenantId} at the configured cap. ` +
            'Raise DATABASE_TENANT_POOLS if this is frequent.',
        ),
      onDisconnectError: (tenantId, error) =>
        this.logger.warn(
          `Closing tenant ${tenantId}'s pool failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    /**
     * The service answers for its own members and delegates everything else to
     * the connection the current scope resolves to. Returning a proxy from the
     * constructor keeps `this.prisma` the only thing anybody holds, so there is
     * no unrouted client sitting beside it for autocomplete to find.
     *
     * Its own members are read off its own prototype rather
     * than written out. A hand-kept list is a list that goes stale the first
     * time somebody adds a method and cannot work out why it reaches the
     * database instead of running.
     *
     * `then` is here for a different reason: without it, `await prismaService`
     * would look up `then` on a client, find nothing, and quietly resolve to the
     * proxy — but an accidental `await` on the service should not open a
     * connection to decide that.
     */
    const own = new Set<string | symbol>([
      ...Object.getOwnPropertyNames(PrismaService.prototype),
      ...Object.getOwnPropertyNames(this),
      'then',
    ]);

    return new Proxy(this, {
      get: (target, property, receiver): unknown => {
        if (own.has(property)) return Reflect.get(target, property, receiver);
        const client = this.registry.forScope(currentScope());
        const value = Reflect.get(client, property, client);
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(client)
          : value;
      },
    }) as PrismaService;
  }

  private createClient(url: string): PrismaClient {
    const client = new PrismaClient({
      datasources: { db: { url } },
      /**
       * Transaction budgets, configured rather than defaulted.
       *
       * Writes to one account serialise on its ledger row — that lock is what
       * keeps concurrent deposits from double-counting. A queued write is
       * therefore normal, and Prisma's 5s default expired transactions that were
       * only waiting their turn.
       */
      transactionOptions: {
        timeout: this.config.get('DATABASE_TRANSACTION_TIMEOUT_MS', { infer: true }),
        maxWait: this.config.get('DATABASE_TRANSACTION_MAX_WAIT_MS', { infer: true }),
      },
    });
    // Layer one rides on every client. Two independent mechanisms, still.
    return client.$extends(tenantScopeExtension()) as unknown as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    this.isolation = await probeTenantIsolation(
      this.registry.unscopedClient(),
      this.registry.privilegedClient(),
    );

    if (this.isolation.enforced === true) {
      this.logger.log(`Database connection established; tenant isolation enforced at the database`);
      return;
    }

    const configured = this.config.get('DATABASE_URL_TENANT', { infer: true }) !== undefined;
    const message =
      `Tenant isolation is NOT enforced at the database: ${this.isolation.reason}. ` +
      'Row-level security exempts a table owner from its own policies, so the application ' +
      'is relying on the Prisma extension alone. See docs/multi-tenancy.md.';

    if (configured && this.isolation.enforced === false) {
      // The operator asked for the two-role setup. Silently not having it is
      // the failure this check exists to prevent.
      throw new Error(`DATABASE_URL_TENANT is set but ${this.isolation.reason}`);
    }
    this.logger.warn(message);
  }

  async onModuleDestroy(): Promise<void> {
    await this.registry.disconnectAll();
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<void> {
    await this.registry.unscopedClient().$queryRaw`SELECT 1`;
  }
}
