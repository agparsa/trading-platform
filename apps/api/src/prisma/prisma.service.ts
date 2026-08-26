import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.schema';

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
