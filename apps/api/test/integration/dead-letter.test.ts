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

  /**
   * Each case below sets up the state it needs and none inherits another's.
   *
   * That was not true when the age gauge was added: the first case left a
   * failed job in `reconciliation`, the third quietly depended on it, and
   * inserting a new case between them broke both. A suite whose result depends
   * on the order its cases happen to run in is measuring the order.
   */
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
  /**
   * And *when* the newest one gave up, which is the difference between an alert
   * that pages about a live problem and one that pages about history.
   *
   * The depth gauge's first scrape on production reported 45: every scheduled
   * reconciliation between 31 August and 2 September, from a fault fixed on the
   * 2nd. Correct, and what `removeOnFail: false` is for — and an alert on depth
   * alone would have paged about it every five minutes for ever.
   */
  it('reports how long ago the newest failure was, and -1 when there are none', async () => {
    const metrics = new MetricsService();
    const service = new PlatformMetricsService(
      undefined as never,
      metrics,
      undefined as never,
      undefined as never,
      undefined as never,
      publisher,
    );
    const refresh = (
      service as unknown as { refreshDeadLetters(): Promise<void> }
    ).refreshDeadLetters.bind(service);

    /**
     * Start from empty rather than assuming it. The case above leaves a failed
     * job in this same queue, so this test passed or failed by position in the
     * file — which is a test measuring the run order, not the gauge.
     */
    const clean = new Queue('reconciliation', { connection });
    await clean.clean(0, 100, 'failed');
    await clean.close();

    await refresh();
    const withNone = await metrics.registry.getSingleMetricAsString(
      'tp_dead_letter_newest_age_ms',
    );
    // Every queue is empty at this point: -1, not 0. Zero would read as "one
    // failed this instant", which is the opposite of the truth.
    expect(withNone).toMatch(/tp_dead_letter_newest_age_ms\{queue="reconciliation"\} -1/);

    /**
     * Two failures with a gap, because one cannot tell *newest* from *oldest*.
     * A mutation that read the oldest instead survived a single-failure version
     * of this test — and "how long since the last thing went wrong" read as
     * "how long since the first thing went wrong" is precisely the confusion
     * that makes an alert page about history.
     */
    await failOneJob('reconciliation');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await failOneJob('reconciliation');

    await refresh();
    const after = await metrics.registry.getSingleMetricAsString('tp_dead_letter_newest_age_ms');
    const age = Number(
      /tp_dead_letter_newest_age_ms\{queue="reconciliation"\} (-?\d+)/.exec(after)?.[1] ?? 'NaN',
    );
    expect(after).toMatch(/tp_dead_letter_depth\{queue="reconciliation"\} 2|/);
    // Younger than the gap: this is the second failure's age, not the first's.
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age, 'the gauge is reporting the oldest failure, not the newest').toBeLessThan(1_400);

    // Untouched queues keep the sentinel rather than inheriting a neighbour's age.
    expect(after).toMatch(/tp_dead_letter_newest_age_ms\{queue="outbox-relay"\} -1/);

    const queue = new Queue('reconciliation', { connection });
    await queue.clean(0, 100, 'failed');
    await queue.close();
    await refresh();
    const drained = await metrics.registry.getSingleMetricAsString(
      'tp_dead_letter_newest_age_ms',
    );
    expect(drained).toMatch(/tp_dead_letter_newest_age_ms\{queue="reconciliation"\} -1/);
  }, 20_000);

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

    /**
     * Its own failure, rather than one left behind by an earlier case. This
     * file used to lean on that and the tests passed or failed by their
     * position in it — which measures the run order, not the gauge.
     */
    await failOneJob('reconciliation');

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
