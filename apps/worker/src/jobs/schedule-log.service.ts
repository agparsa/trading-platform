import { Injectable, Logger } from '@nestjs/common';
import { withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma.service';

/**
 * Records when each scheduled job ran, so that one going quiet can be seen.
 *
 * ## Why this is not a metric
 *
 * The obvious place for "when did this last run" is a Prometheus gauge, and it
 * would be the wrong place. The question is asked *after* something has gone
 * wrong, often after a Redis flush or a worker that never came back, and a
 * record that lives in the same infrastructure as the failure is not a record.
 * A row in PostgreSQL survives all of it and can be read by the API, by the
 * production verifier and by a person with psql at three in the morning.
 *
 * The metric exists too, derived from these rows. It is the alarm; this is the
 * evidence.
 *
 * ## Recording a failure is the point, not an afterthought
 *
 * A job that runs every minute and throws every time is neither quiet nor
 * working, and the naive version of this service — write a row when the job
 * finishes — would call it healthy, because something did happen recently. So
 * the outcome is recorded either way, `lastSucceededAt` is kept separately from
 * `finishedAt`, and the distance between those two is what tells an operator
 * that a job has been failing all week rather than merely failing now.
 */
@Injectable()
export class ScheduleLogService {
  private readonly logger = new Logger(ScheduleLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Notes that a scheduled run has begun.
   *
   * The cron is written on every start rather than once at registration: the
   * pattern can change with a redeploy, and lateness must be judged against the
   * schedule actually in force. A tolerance computed from a pattern nobody uses
   * any more is an alarm that fires for the wrong reason or not at all.
   */
  async started(name: string, cron: string, at: Date = new Date()): Promise<void> {
    await withoutTenantScope('a schedule belongs to the deployment, not to a firm', () =>
      this.prisma.scheduledJobRun.upsert({
        where: { name },
        create: { name, cron, startedAt: at },
        update: { cron, startedAt: at, finishedAt: null, outcome: null, durationMs: null },
      }),
    ).catch((error: unknown) => {
      // Never fail a job because its bookkeeping failed. A reconciliation run
      // that refuses to start because this table is locked would be a watchdog
      // that takes down what it watches.
      this.logger.warn({ err: error, name }, 'Could not record the start of a scheduled job');
    });
  }

  /** Notes that it finished, and whether it worked. */
  async finished(
    name: string,
    outcome: 'OK' | 'FAILED',
    detail: { readonly startedAt: Date; readonly error?: string },
    at: Date = new Date(),
  ): Promise<void> {
    const durationMs = Math.max(0, at.getTime() - detail.startedAt.getTime());
    /**
     * The reason in words, never a stack trace.
     *
     * This string is shown on an operations screen and returned by a health
     * probe. A stack trace there tells an operator nothing they can act on and
     * tells anybody reading over their shoulder the shape of the codebase.
     */
    const error =
      outcome === 'FAILED' ? (detail.error ?? 'no reason recorded').slice(0, 500) : null;

    await withoutTenantScope('a schedule belongs to the deployment, not to a firm', () =>
      this.prisma.scheduledJobRun.update({
        where: { name },
        data: {
          finishedAt: at,
          durationMs,
          outcome,
          error,
          runs: { increment: 1 },
          ...(outcome === 'FAILED'
            ? { failures: { increment: 1 } }
            : { lastSucceededAt: at, error: null }),
        },
      }),
    ).catch((err: unknown) => {
      this.logger.warn({ err, name }, 'Could not record the end of a scheduled job');
    });
  }

  /** Every schedule the platform has a record of. */
  async all(): Promise<
    readonly {
      name: string;
      cron: string;
      startedAt: Date;
      finishedAt: Date | null;
      outcome: string | null;
      error: string | null;
      runs: number;
      failures: number;
      lastSucceededAt: Date | null;
    }[]
  > {
    return withoutTenantScope('a schedule belongs to the deployment, not to a firm', () =>
      this.prisma.scheduledJobRun.findMany({ orderBy: { name: 'asc' } }),
    );
  }
}
