import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ALL_QUEUES, DEFAULT_JOB_OPTIONS, QueueName } from './queues';
import type { WorkerEnv } from './env';

/**
 * Owns the BullMQ connections and the worker processes attached to each queue.
 *
 * Phase 1 stands the infrastructure up and verifies it connects. No processors
 * are registered yet: swap accrual, snapshots and reconciliation are Phase 5
 * and Phase 13 work, and a queue that silently completes jobs it has not
 * actually done would be worse than one that is empty.
 */
@Injectable()
export class QueueRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  // Injected by explicit token — see the note in the API's RedisService.
  constructor(@Inject(ConfigService) config: ConfigService<WorkerEnv, true>) {
    this.connection = new IORedis(config.get('REDIS_URL', { infer: true }), {
      // BullMQ requires this to be null: its blocking commands must not time out.
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connection.connect();
    for (const name of ALL_QUEUES) {
      this.queues.set(
        name,
        new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
      );
    }
    this.logger.log(`Queue registry ready: ${ALL_QUEUES.join(', ')}`);
    this.logger.warn('No job processors are registered yet — scheduled work lands in Phase 5.');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit();
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (queue === undefined) throw new Error(`Queue '${name}' is not registered`);
    return queue;
  }
}
