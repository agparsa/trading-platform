import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ALL_QUEUES, QueueName } from './queues';
import type { Env } from '../config/env.schema';

/**
 * The API's side of the job queues: publishing only.
 *
 * No worker is attached here, and that is the whole design. The API serves
 * requests; the worker runs the jobs. A processor in this process would run
 * sweeps and reconciliations on whichever API replica happened to pick them up,
 * competing for the same database connections the trading path needs — during
 * exactly the busy periods when both matter.
 *
 * The connection is its own, separate from `RedisService`. BullMQ requires
 * `maxRetriesPerRequest: null` for its blocking commands, and that setting has
 * no business on the connection that serves quotes.
 */
@Injectable()
export class QueuePublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueuePublisher.name);
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.connection = new IORedis(config.getOrThrow('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connection.connect();
    for (const name of ALL_QUEUES) {
      this.queues.set(name, new Queue(name, { connection: this.connection }));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }

  /**
   * Adds a job.
   *
   * `jobId` makes the add idempotent: BullMQ refuses a second job with an id
   * already present, so a retried request cannot queue the same run twice.
   */
  async publish(
    name: QueueName,
    jobName: string,
    data: Record<string, unknown>,
    jobId?: string,
  ): Promise<void> {
    const queue = this.queues.get(name);
    if (queue === undefined) throw new Error(`Queue '${name}' is not registered`);
    await queue.add(jobName, data, jobId === undefined ? {} : { jobId });
    this.logger.log({ queue: name, jobName, jobId }, 'Job published');
  }

  /**
   * How many jobs are sitting in each queue's failed set.
   *
   * `removeOnFail: false` is deliberate — `queues.ts` says a failed financial
   * job "stays visible in the dead-letter set until a human has looked at it" —
   * and until now the only way to see that set was to open Redis by hand.
   * `docs/observability.md` lists dead-letter depth under *What to alert on*,
   * which nothing could do: there was no series to alert on.
   *
   * Read from here because this is where the `Queue` handles already live.
   * `getFailedCount` is a `ZCARD` on a key BullMQ maintains, so it costs one
   * round trip per queue and reads nothing the library does not expose.
   */
  async failedCounts(): Promise<Array<{ queue: QueueName; failed: number }>> {
    return Promise.all(
      [...this.queues.entries()].map(async ([queue, handle]) => ({
        queue,
        failed: await handle.getFailedCount(),
      })),
    );
  }
}
