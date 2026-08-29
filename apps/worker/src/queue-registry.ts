import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { ALL_QUEUES, DEFAULT_JOB_OPTIONS, QueueName } from './queues';
import type { WorkerEnv } from './env';
import { SwapAccrualService } from './jobs/swap-accrual.service';
import { ReconciliationService } from './jobs/reconciliation.service';
import { MaintenanceService } from './jobs/maintenance.service';
import { NotificationsService } from './jobs/notifications.service';

/**
 * Owns the BullMQ connections, the workers attached to each queue, and the
 * schedules that feed them.
 *
 * Every processor here is a thin wrapper around a service method that can be
 * called directly. The schedule is glue; the behaviour is testable without
 * Redis, without BullMQ and without waiting for a cron to fire.
 */
@Injectable()
export class QueueRegistry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnv, true>,
    private readonly swaps: SwapAccrualService,
    private readonly reconciliation: ReconciliationService,
    private readonly maintenance: MaintenanceService,
    private readonly notifications: NotificationsService,
  ) {
    this.connection = new IORedis(config.getOrThrow('REDIS_URL', { infer: true }), {
      // BullMQ requires this to be null: its blocking commands must not time out.
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.connection.connect();

    for (const name of ALL_QUEUES) {
      this.queues.set(
        name,
        new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
      );
    }

    this.attach(QueueName.SWAP_ACCRUAL, async () => this.swaps.accrue());
    /**
     * A manual run carries the id of a row the API already created, so the
     * console can show a run that has been *requested* rather than a button
     * that appears to do nothing until this process gets round to it.
     */
    this.attach(QueueName.RECONCILIATION, async (job) => {
      const runId = (job.data as { runId?: unknown }).runId;
      return this.reconciliation.check(
        typeof runId === 'string' ? { runId, trigger: 'MANUAL' } : { trigger: 'SCHEDULED' },
      );
    });
    this.attach(QueueName.IDEMPOTENCY_SWEEP, async () => ({
      expired: await this.maintenance.sweepIdempotencyKeys(),
      abandoned: await this.maintenance.releaseAbandonedClaims(),
    }));
    this.attach(QueueName.NOTIFICATIONS, async (job) => this.notifications.deliver(job.data));

    await this.schedule();

    if (this.config.getOrThrow('RUN_JOBS_ON_BOOT', { infer: true })) {
      this.logger.warn('RUN_JOBS_ON_BOOT is set — running every scheduled job once, now');
      await this.queue(QueueName.SWAP_ACCRUAL).add('boot', {});
      await this.queue(QueueName.RECONCILIATION).add('boot', {});
      await this.queue(QueueName.IDEMPOTENCY_SWEEP).add('boot', {});
    }

    this.logger.log(`Queue registry ready: ${ALL_QUEUES.join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (queue === undefined) throw new Error(`Queue '${name}' is not registered`);
    return queue;
  }

  private attach(name: QueueName, run: (job: Job) => Promise<unknown>): void {
    const worker = new Worker(
      name,
      async (job) => {
        const startedAt = Date.now();
        const result = await run(job);
        this.logger.log({ queue: name, ms: Date.now() - startedAt, result }, 'Job completed');
        return result;
      },
      {
        connection: this.connection,
        // One at a time per queue. These jobs sweep whole tables; running two
        // copies concurrently buys nothing and doubles the lock contention.
        concurrency: 1,
      },
    );

    worker.on('failed', (job, error) => {
      this.logger.error(
        { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'Job failed',
      );
    });

    this.workers.push(worker);
  }

  /**
   * Registers the repeating schedules.
   *
   * `upsertJobScheduler` is idempotent: restarting the worker re-registers the
   * same schedule rather than accumulating duplicates, which a plain repeatable
   * `add` would do.
   */
  private async schedule(): Promise<void> {
    const tz = this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true });

    const schedules: Array<[QueueName, string]> = [
      [QueueName.SWAP_ACCRUAL, this.config.getOrThrow('SWAP_ACCRUAL_CRON', { infer: true })],
      [QueueName.RECONCILIATION, this.config.getOrThrow('RECONCILIATION_CRON', { infer: true })],
      [QueueName.IDEMPOTENCY_SWEEP, this.config.getOrThrow('MAINTENANCE_CRON', { infer: true })],
    ];

    for (const [name, pattern] of schedules) {
      await this.queue(name).upsertJobScheduler(
        `${name}-schedule`,
        { pattern, tz },
        { name: 'scheduled' },
      );
      this.logger.log(`Scheduled ${name}: '${pattern}' (${tz})`);
    }
  }
}
