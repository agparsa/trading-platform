import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Turns a queued event into something a person will see.
 *
 * ## Why this is a job and not a socket frame
 *
 * A socket frame reaches whoever is looking. A margin call that only exists
 * because the trader's browser happened to be open is a margin call the person
 * who stepped away never got — and stepping away is when it matters. So the
 * notification is written to the database first, and the socket, the bell and
 * (when a transport is wired) the email are all readers of that row.
 *
 * ## Delivery today
 *
 * **In-app only.** The row is written, `GET /notifications` serves it and the
 * terminal shows it. `emailedAt` exists and stays null: there is no email
 * transport in this process, and marking a row as emailed when nothing was sent
 * would be worse than not having the column. Wiring a provider means
 * implementing one port and setting `emailedAt` — nothing else here changes.
 *
 * ## Duplicates
 *
 * `dedupeKey` carries a unique constraint. A risk engine that raises the same
 * alert twice in one minute — two API instances both noticing the same
 * transition, a job retried after a timeout that had in fact succeeded —
 * produces one row, and the second insert is recognised rather than failing the
 * job.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  async deliver(payload: unknown): Promise<{ created: boolean; id: string | null }> {
    const job = parse(payload);
    if (job === null) {
      // A malformed job is a producer bug, and failing it would retry the same
      // malformed payload five times before giving up. Recorded and dropped.
      this.logger.error({ payload }, 'Notification job could not be read; dropping it');
      return { created: false, id: null };
    }

    if (job.dedupeKey !== null) {
      const existing = await this.prisma.notification.findUnique({
        where: { tenantId_dedupeKey: { tenantId: job.tenantId, dedupeKey: job.dedupeKey } },
        select: { id: true },
      });
      if (existing !== null) return { created: false, id: existing.id };
    }

    try {
      const created = await this.prisma.notification.create({
        data: {
          tenantId: job.tenantId,
          userId: job.userId,
          kind: job.kind,
          severity: job.severity,
          title: job.title,
          body: job.body,
          data: job.data as Prisma.InputJsonValue,
          accountId: job.accountId,
          dedupeKey: job.dedupeKey,
        },
        select: { id: true },
      });
      return { created: true, id: created.id };
    } catch (error) {
      // The unique constraint losing a race is the *expected* outcome when two
      // producers notice the same thing at once. It is not a failure.
      if (isUniqueViolation(error) && job.dedupeKey !== null) {
        const winner = await this.prisma.notification.findUnique({
          where: { tenantId_dedupeKey: { tenantId: job.tenantId, dedupeKey: job.dedupeKey } },
          select: { id: true },
        });
        return { created: false, id: winner?.id ?? null };
      }
      throw error;
    }
  }

  constructor(private readonly prisma: PrismaService) {}
}

interface NotificationJob {
  tenantId: string;
  userId: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  accountId: string | null;
  dedupeKey: string | null;
}

/**
 * Reads a job payload, or returns null.
 *
 * Every field is checked rather than the object being cast. A job arrives over
 * Redis from another process and another deployment of it; trusting its shape is
 * trusting a version of the producer that may not be the one running.
 */
export function parse(payload: unknown): NotificationJob | null {
  if (payload === null || typeof payload !== 'object') return null;
  const input = payload as Record<string, unknown>;

  const text = (key: string, max: number): string | null => {
    const value = input[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' || trimmed.length > max ? null : trimmed;
  };

  const tenantId = text('tenantId', 64);
  const userId = text('userId', 64);
  const kind = text('kind', 64);
  const title = text('title', 200);
  const body = text('body', 2_000);
  /**
   * A job with no tenant is refused rather than defaulted.
   *
   * The tempting alternative is to look the tenant up from `userId`. That would
   * work, and it would mean a producer that forgot the field kept working — so
   * nobody would ever fix it, and the day a job arrived with a userId from a
   * different tenant than the one that raised it, the notification would be
   * filed under the wrong firm with no trace of how.
   */
  if (tenantId === null || userId === null || kind === null || title === null || body === null) {
    return null;
  }

  const severity = text('severity', 16) ?? 'INFO';
  if (!['INFO', 'WARNING', 'CRITICAL'].includes(severity)) return null;

  return {
    tenantId,
    userId,
    kind,
    severity,
    title,
    body,
    data:
      input['data'] !== null && typeof input['data'] === 'object' && !Array.isArray(input['data'])
        ? (input['data'] as Record<string, unknown>)
        : {},
    accountId: text('accountId', 64),
    dedupeKey: text('dedupeKey', 200),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
  );
}
