import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { QueuePublisher } from '../../src/jobs/queue-publisher.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import { PlatformMetricsService } from '../../src/metrics/platform-metrics.service';

/**
 * The dead-letter set, which nothing could see.
 *
 * `queues.ts` sets `removeOnFail: false` under a comment saying a failed
 * financial job "must stay visible in the dead-letter set until a human has
 * looked at it", and `docs/observability.md` has listed dead-letter depth under
 * *What to alert on* since it was written. Between those two sentences there
 * was no series, no gauge and no query: the only way to see the set was to open
 * Redis by hand, and the row in the table could not have been implemented by
 * anybody who tried.
 *
 * Run against a real Redis on its own database, with a real worker that throws,
 * because the thing being checked is whether a genuinely failed job shows up —
 * not whether a mock returns what it was told to.
 */
const url = process.env['REDIS_URL'];
const suite = url === undefined || url === '' ? describe.skip : describe;

/** Its own database: these queue names are the platform's, and other suites share the server. */
const isolated = `${url ?? ''}/9`;

class StubConfig {
  getOrThrow(): string {
    return isolated;
  }
}

suite('dead-letter depth', () => {
  let publisher: QueuePublisher;
  let connection: IORedis;

  beforeAll(async () => {
    connection = new IORedis(isolated, { maxRetriesPerRequest: null });
    await connection.flushdb();
    publisher = new QueuePublisher(new StubConfig() as never);
    await publisher.onModuleInit();
  });

  afterAll(async () => {
    await publisher?.onApplicationShutdown();
    await connection?.flushdb();
    await connection?.quit();
  });

  const failOneJob = async (queueName: string): Promise<void> => {
    const queue = new Queue(queueName, { connection });
    const worker = new Worker(
      queueName,
      () => {
        throw new Error('the venue refused, and kept refusing');
      },
      { connection, autorun: true },
    );
    const failed = new Promise<void>((resolve) => worker.once('failed', () => resolve()));
    // One attempt, kept on failure: the platform's own default for a job that
    // has exhausted its retries.
    await queue.add('probe', {}, { attempts: 1, removeOnFail: false });
    await failed;
    await worker.close();
    await queue.close();
  };

  it('counts a job that gave up, in the queue it gave up in', async () => {
    const before = await publisher.failedCounts();
    expect(before.every((row) => row.failed === 0), 'the database was not clean').toBe(true);
    expect(before.length, 'every queue is reported, not only the failing ones').toBeGreaterThan(5);

    await failOneJob('reconciliation');

    const after = await publisher.failedCounts();
    expect(after.find((row) => row.queue === 'reconciliation')?.failed).toBe(1);
    // And only that one: a depth attributed to the wrong queue sends somebody
    // to the wrong logs.
    expect(after.filter((row) => row.failed > 0).map((row) => row.queue)).toEqual([
      'reconciliation',
    ]);
  }, 20_000);

  /**
   * The gauge, and the property that keeps it honest: it comes back down.
   *
   * Not the `reset()` — that is consistency with the gauges above rather than a
   * guarantee here, because these labels come from a constant and the series
   * set never shrinks. What matters is that every queue is published every
   * pass, including the ones at zero. A gauge written only when it is non-zero
   * would page for ever after somebody cleared the job, which is precisely the
   * moment they stop believing the alert.
   *
   * Asserted by draining the set and reading the series, rather than by reading
   * the code.
   */
  it('publishes the depth, and follows the set back down', async () => {
    const metrics = new MetricsService();
    const service = new PlatformMetricsService(
      undefined as never,
      metrics,
      undefined as never,
      undefined as never,
      undefined as never,
      publisher,
    );
    const refresh = (service as unknown as { refreshDeadLetters(): Promise<void> }).refreshDeadLetters.bind(
      service,
    );

    await refresh();
    const withJob = await metrics.registry.getSingleMetricAsString('tp_dead_letter_depth');
    expect(withJob).toMatch(/tp_dead_letter_depth\{queue="reconciliation"\} 1/);

    const queue = new Queue('reconciliation', { connection });
    await queue.clean(0, 100, 'failed');
    await queue.close();

    await refresh();
    const drained = await metrics.registry.getSingleMetricAsString('tp_dead_letter_depth');
    expect(drained).toMatch(/tp_dead_letter_depth\{queue="reconciliation"\} 0/);
    expect(drained).not.toMatch(/queue="reconciliation"\} [1-9]/);
  }, 20_000);
});
