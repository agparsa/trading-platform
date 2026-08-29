import { Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { QueueName } from '../jobs/queues';

/**
 * What the platform has told this person.
 *
 * Reading is direct; *raising* one is a queued job, and the asymmetry is
 * deliberate. A notification raised inline would tie a trade's latency to a
 * table write nobody is waiting for, and — worse — a failure to record the
 * notice would become a failure of the thing that caused it. A margin call that
 * rolled back a stop-out because the alert could not be written would be the
 * most expensive notification in the platform.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuePublisher,
  ) {}

  async list(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<NotificationRow[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...(options.unreadOnly === true ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      data: row.data,
      accountId: row.accountId,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * Mark one as read.
   *
   * Scoped by `userId` in the same query that finds it, so somebody else's
   * notification id is *not found* rather than found and refused — the two are
   * indistinguishable to the caller, which is the point.
   */
  async markRead(userId: string, id: string): Promise<{ id: string }> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such unread notification');
    }
    return { id };
  }

  async markAllRead(userId: string): Promise<{ marked: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: result.count };
  }

  /**
   * Raise one.
   *
   * Never throws into the caller. This is called from the risk path, and a
   * queue that is briefly unreachable must not fail a stop-out — the trade is
   * the thing that matters and the notice is about it. A failure here is logged
   * loudly and swallowed, which is the same rule `EventsService.publish`
   * follows and for the same reason.
   */
  async raise(job: {
    userId: string;
    kind: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    body: string;
    data?: Record<string, unknown>;
    accountId?: string | null;
    /** Makes the notice unique. Two producers noticing the same thing write one row. */
    dedupeKey?: string | null;
  }): Promise<void> {
    try {
      await this.queues.publish(QueueName.NOTIFICATIONS, job.kind, {
        userId: job.userId,
        kind: job.kind,
        severity: job.severity,
        title: job.title,
        body: job.body,
        data: job.data ?? {},
        accountId: job.accountId ?? null,
        dedupeKey: job.dedupeKey ?? null,
      });
    } catch (error) {
      this.logger.error({ err: error, kind: job.kind }, 'Could not queue a notification');
    }
  }
}

export interface NotificationRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  data: unknown;
  accountId: string | null;
  readAt: string | null;
  createdAt: string;
}
