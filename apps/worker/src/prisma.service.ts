import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  TenantClientRegistry,
  currentScope,
  probeTenantIsolation,
  tenantScopeExtension,
} from '@tp/tenancy';
import type { WorkerEnv } from './env';

/**
 * The worker's database, routed by tenant. Same schema as the API's, separate
 * pools.
 *
 * It carries the tenant-scope extension for a stronger reason than the API does:
 * the worker has no request and no middleware, so nothing else would ever put a
 * tenant in scope. A job that queried without a tenant filter would read every
 * firm's rows and look entirely normal doing it.
 *
 * And it routes per tenant for the same reason the API does — see
 * `apps/api/src/prisma/prisma.service.ts` for the full argument and
 * `packages/tenancy/src/connection.ts` for why the tenant rides on the
 * connection rather than on a transaction. Work that genuinely spans tenants —
 * the reconciliation sweep listing which tenants exist — says so with
 * `withoutTenantScope` and gets the privileged connection; everything inside a
 * tenant's sweep runs inside `withTenant` and gets that tenant's.
 */
/* See apps/api/src/prisma/prisma.service.ts for why the merge is deliberate and
 * what asserts that it stays true. */
/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type */
export interface PrismaService extends PrismaClient {}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly registry: TenantClientRegistry<PrismaClient>;
  private readonly tenantRoleConfigured: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<WorkerEnv, true>) {
    const owner = config.get('DATABASE_URL', { infer: true });
    this.tenantRoleConfigured = config.get('DATABASE_URL_TENANT', { infer: true }) !== undefined;

    this.registry = new TenantClientRegistry<PrismaClient>({
      tenantUrl: config.get('DATABASE_URL_TENANT', { infer: true }) ?? owner,
      privilegedUrl: owner,
      maxClients: config.get('DATABASE_TENANT_POOLS', { infer: true }),
      createClient: (url) =>
        new PrismaClient({ datasources: { db: { url } } }).$extends(
          tenantScopeExtension(),
        ) as unknown as PrismaClient,
      onEvict: (tenantId) =>
        this.logger.log(
          `Evicted the connection pool for tenant ${tenantId} at the configured cap.`,
        ),
      onDisconnectError: (tenantId, error) =>
        this.logger.warn(
          `Closing tenant ${tenantId}'s pool failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

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

  /**
   * The worker probes separately from the API on purpose. They read the same
   * database but are configured, deployed and restarted independently, so
   * "the API said it was fine" is not evidence about this process.
   */
  async onModuleInit(): Promise<void> {
    const isolation = await probeTenantIsolation(
      this.registry.unscopedClient(),
      this.registry.privilegedClient(),
    );

    if (isolation.enforced === true) {
      this.logger.log('Database ready; tenant isolation enforced at the database');
      return;
    }
    if (this.tenantRoleConfigured && isolation.enforced === false) {
      throw new Error(`DATABASE_URL_TENANT is set but ${isolation.reason}`);
    }
    this.logger.warn(
      `Tenant isolation is NOT enforced at the database: ${isolation.reason}. ` +
        'Jobs are relying on the Prisma extension alone. See docs/multi-tenancy.md.',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.registry.disconnectAll();
  }
}
