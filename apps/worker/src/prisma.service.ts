import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantScopeExtension } from '@tp/tenancy';

/**
 * The worker's own client. Same schema, separate connection pool from the API.
 *
 * It carries the same tenant-scope extension the API's does, and for a stronger
 * reason: the worker has no request and no middleware, so nothing else would
 * ever put a tenant in scope. Without the extension a job that queried without
 * a tenant filter would read every firm's rows and look entirely normal doing
 * it — which is the failure the extension exists to make loud.
 *
 * Work that genuinely spans tenants — the reconciliation sweep listing which
 * tenants exist — says so with `withoutTenantScope`, and everything inside a
 * tenant's sweep runs inside `withTenant`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();
    // See apps/api/src/prisma/prisma.service.ts for why the constructor returns
    // the extended client rather than exposing it as a property.
    return this.$extends(tenantScopeExtension()) as unknown as PrismaService;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
