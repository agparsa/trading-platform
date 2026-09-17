import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { Env } from '../config/env.schema';
import { currentIdempotencyClaim } from '../common/request-scope';
import {
  connectionBudget,
  connectionLimitOf,
  describeConnectionBudget,
  type ServerCapacity,
} from './connection-budget';
import {
  TenantClientRegistry,
  currentScope,
  probeTenantIsolation,
  shouldReprobe,
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

  /** What the last probe found. Exposed so the health endpoint can report it. */
  public isolation: IsolationState = {
    enforced: 'unknown',
    role: 'unknown',
    reason: 'not probed yet',
  };

  private lastProbeAt = 0;

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

  /**
   * A transaction, with the request's idempotency claim committed inside it.
   *
   * ## The window this closes
   *
   * An idempotent operation claims its key, runs, and then records the result
   * against the claim. Between the operation's commit and that recording there
   * were a few milliseconds in which the process could die — and did, under
   * failure injection: 39 of 40 orders had filled, none of their claims said
   * so, every retry with the same key was refused as "still in flight", and a
   * client following the only remaining path — a fresh key — would have
   * filled each of them again.
   *
   * So when a request is running under a claim, the interactive transaction is
   * wrapped: after the body has done its work and before the commit, the claim
   * is marked COMMITTED *in the same transaction*. Either both are durable or
   * neither is. A retry that finds COMMITTED is refused with a code that says
   * "already applied, read the account" rather than run again.
   *
   * Overridden here, on the service, so every `this.prisma.$transaction` in
   * every service gets it without knowing. A hook that had to be called from
   * each transaction body would be a hook somebody forgot in one.
   *
   * The array form (a batch of promises) passes straight through: it carries
   * no callback to wrap, and nothing idempotent uses it.
   */
  $transaction<R>(
    arg: ((tx: Prisma.TransactionClient) => Promise<R>) | Prisma.PrismaPromise<unknown>[],
    options?: Parameters<PrismaClient['$transaction']>[1],
  ): Promise<R> {
    const client = this.registry.forScope(currentScope());
    if (typeof arg !== 'function') {
      return client.$transaction(arg, options as never) as unknown as Promise<R>;
    }
    const claimId = currentIdempotencyClaim();
    if (claimId === null) return client.$transaction(arg, options as never);
    return client.$transaction(async (tx) => {
      const result = await arg(tx);
      await tx.idempotencyKey.updateMany({
        where: { id: claimId, status: 'IN_PROGRESS' },
        data: { status: 'COMMITTED' },
      });
      return result;
    }, options as never);
  }

  /** Whether the operator asked for the two-role deployment. */
  get tenantRoleConfigured(): boolean {
    return this.config.get('DATABASE_URL_TENANT', { infer: true }) !== undefined;
  }

  /**
   * The isolation state, asked again while the answer is still unknown.
   *
   * The probe reads a tenant table with no tenant bound and expects zero rows —
   * and says so itself: zero rows proves nothing when the table is empty. The
   * table it uses is `users`, chosen because it "is never empty in a running
   * deployment". It is empty at exactly one moment: **boot, on a fresh
   * install** — which was the only moment anything asked.
   *
   * So a new deployment answered `unknown`, the first person registered a
   * minute later, and nothing ever asked again. The promised refusal —
   * `DATABASE_URL_TENANT` set and the policies not biting — could not fire on
   * the deployment where getting it wrong costs the most.
   *
   * Once the answer is definite it is kept. Ownership and role membership do
   * not change under a running process, and re-asking a settled question every
   * fifteen seconds would be a query on the trading path's own pool for no new
   * information.
   */
  async resolveTenantIsolation(): Promise<IsolationState> {
    const now = Date.now();
    if (!shouldReprobe(this.isolation, this.lastProbeAt, now)) return this.isolation;
    this.lastProbeAt = now;

    this.isolation = await probeTenantIsolation(
      this.registry.unscopedClient(),
      this.registry.privilegedClient(),
    );
    if (this.isolation.enforced !== 'unknown') this.announceIsolation();
    return this.isolation;
  }

  async onModuleInit(): Promise<void> {
    this.lastProbeAt = Date.now();
    this.isolation = await probeTenantIsolation(
      this.registry.unscopedClient(),
      this.registry.privilegedClient(),
    );
    await this.reportConnectionBudget();

    if (this.tenantRoleConfigured && this.isolation.enforced === false) {
      // The operator asked for the two-role setup. Silently not having it is
      // the failure this check exists to prevent. Refusing to boot is only
      // available here; once the process is serving, the same discovery takes
      // readiness down instead — see `TenantIsolationHealthIndicator`.
      throw new Error(`DATABASE_URL_TENANT is set but ${this.isolation.reason}`);
    }
    this.announceIsolation();
  }

  /**
   * Says what the probe found, once per distinct answer.
   *
   * At `error` rather than `warn` when the operator asked for isolation and it
   * is not there, because that pair is a misconfiguration and not a posture.
   */
  private announceIsolation(): void {
    if (this.isolation.enforced === true) {
      this.logger.log('Database connection established; tenant isolation enforced at the database');
      return;
    }
    const message =
      `Tenant isolation is NOT enforced at the database: ${this.isolation.reason}. ` +
      'Row-level security exempts a table owner from its own policies, so the application ' +
      'is relying on the Prisma extension alone. See docs/multi-tenancy.md.';
    if (this.tenantRoleConfigured && this.isolation.enforced === false) {
      this.logger.error(`DATABASE_URL_TENANT is set but ${this.isolation.reason}`);
      return;
    }
    this.logger.warn(message);
  }

  async onModuleDestroy(): Promise<void> {
    await this.registry.disconnectAll();
  }

  /**
   * What this process may ask of the database, against what the database has.
   *
   * See `connection-budget.ts` for why. A warning, never a refusal: the budget
   * is a ceiling a one-tenant deployment never reaches. If the server cannot
   * be asked — a pooler in front of it, a role without `SHOW` — the check is
   * skipped and says so, at debug, because nothing has gone wrong.
   */
  private async reportConnectionBudget(): Promise<void> {
    const owner = this.config.get('DATABASE_URL', { infer: true });
    const tenantUrl = this.config.get('DATABASE_URL_TENANT', { infer: true }) ?? owner;
    const input = {
      tenantPools: this.config.get('DATABASE_TENANT_POOLS', { infer: true }),
      tenantConnectionLimit: connectionLimitOf(tenantUrl),
      privilegedConnectionLimit: connectionLimitOf(owner),
    };

    let server: ServerCapacity;
    try {
      const rows = await this.registry.privilegedClient().$queryRaw<
        Array<{ name: string; setting: string }>
      >`SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'superuser_reserved_connections')`;
      const setting = (name: string) => Number(rows.find((row) => row.name === name)?.setting);
      server = {
        maxConnections: setting('max_connections'),
        reserved: setting('superuser_reserved_connections'),
      };
      if (!Number.isFinite(server.maxConnections) || !Number.isFinite(server.reserved)) {
        throw new Error('pg_settings did not report both values');
      }
    } catch (error) {
      this.logger.debug(
        `Connection budget not checked: the server's limits could not be read (${
          error instanceof Error ? error.name : String(error)
        })`,
      );
      return;
    }

    const budget = connectionBudget(input, server);
    const message = describeConnectionBudget(budget, input);
    if (budget.fits && budget.instancesThatFit > 1) this.logger.log(message);
    else this.logger.warn(message);
  }

  /**
   * How many tenant pools are open right now. For tests that pin what a code
   * path costs in connections, and for the metric an operator watches against
   * `DATABASE_TENANT_POOLS`.
   */
  get tenantPoolsOpen(): number {
    return this.registry.size;
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<void> {
    await this.registry.unscopedClient().$queryRaw`SELECT 1`;
  }
}
