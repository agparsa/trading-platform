import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.schema';
import { tenantScopeExtension } from '../tenancy/tenant-scope';

/**
 * The Prisma client, owned by Nest's lifecycle.
 *
 * `$transaction` from this service is the only sanctioned way to write more
 * than one financial row: an order, its execution, the position and the ledger
 * entry either all land or none do.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      /**
       * Transaction budgets, configured rather than defaulted.
       *
       * Writes to one account serialise on its ledger row — that lock is what
       * keeps concurrent deposits from double-counting. A queued write is
       * therefore normal, and Prisma's 5s default expired transactions that were
       * only waiting their turn.
       */
      transactionOptions: {
        timeout: config.get('DATABASE_TRANSACTION_TIMEOUT_MS', { infer: true }),
        maxWait: config.get('DATABASE_TRANSACTION_MAX_WAIT_MS', { infer: true }),
      },
    });

    /**
     * Tenant scoping is applied by returning the extended client from the
     * constructor, so that `this.prisma` is the scoped client everywhere and
     * there is no unscoped one to reach for by mistake.
     *
     * A constructor returning a different object is unusual enough to deserve
     * the note: the alternative is exposing the extended client as a property,
     * which leaves the raw one sitting beside it on the same service. Somebody
     * would use it — not maliciously, just by autocomplete — and the whole
     * point of injection over validation (see tenancy/tenant-scope.ts) is that
     * the safe path is the only path.
     *
     * The class's own members survive: `ping`, `onModuleInit` and
     * `onModuleDestroy` are all reachable through the extended client, and
     * `prisma.service.test.ts` asserts it rather than trusting it.
     *
     * `$queryRaw` does **not** pass through the extension. That is not an
     * oversight in this design; it is the reason row-level security exists
     * underneath it.
     */
    return this.$extends(tenantScopeExtension()) as unknown as PrismaService;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
