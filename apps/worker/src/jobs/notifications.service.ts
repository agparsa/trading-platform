import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PushService } from '../push/push.service';
import { withTenant } from '@tp/tenancy';
import { categoryForKind } from '@tp/shared-types';
import { NotificationMailer, composeNotificationEmail } from '../email/notification-mailer';

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
 * **In-app, push and email.** The row is written first; `GET /notifications`
 * serves it, the terminal shows it, `PushService` sends it to the person's
 * registered devices, and — when the person's preferences say so (risk
 * alerts, by default) and the deployment has a mail server — it is emailed to
 * their verified address. `emailedAt` is written only after the mail server
 * has taken the message; until 29 October there was no email transport and it
 * stayed null.
 *
 * ## Push happens only for a row this call created
 *
 * That single condition is what satisfies §26 for the whole platform. The
 * `dedupeKey` unique constraint already collapses two producers noticing the
 * same thing into one row; a second attempt therefore returns `created: false`
 * and never reaches the push path. No separate push-side deduplication exists,
 * because a second mechanism could disagree with the first — and the way that
 * failure presents is a trader's phone buzzing twice for one fill.
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

    /**
     * Everything below runs inside the job's own tenant.
     *
     * The tenant comes from the job payload, which the parser refuses to accept
     * without — see its note on why it is not looked up from `userId`. Entering
     * the scope here rather than passing the id around means a query added to
     * this method later is scoped by default instead of by remembering.
     */
    return withTenant({ tenantId: job.tenantId, slug: job.tenantId }, async () => {
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

        await this.pushQuietly(job, created.id);
        await this.emailQuietly(job, created.id);
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
    });
  }

  /**
   * Pushes, and never lets a push failure fail the job.
   *
   * The row is already committed. A thrown error here would retry the job,
   * which would find the row present, return `created: false`, and never push
   * at all — so the retry would be strictly worse than the failure. Recorded
   * loudly and swallowed.
   */
  private async pushQuietly(job: NotificationJob, notificationId: string): Promise<void> {
    try {
      await this.push.deliver({
        tenantId: job.tenantId,
        userId: job.userId,
        notificationId,
        /**
         * The occurrence this notice is about.
         *
         * Taken from the job when the producer supplied one, so a client that
         * already handled the WebSocket frame for the same event discards the
         * push instead of showing it twice and playing the sound twice. When
         * the producer supplied none, the notification's own id is the next
         * best thing: still stable, still unique, and still processed once.
         */
        eventId: eventIdOf(job, notificationId),
        kind: job.kind,
        severity: job.severity as 'INFO' | 'WARNING' | 'CRITICAL',
        title: job.title,
        body: job.body,
        accountId: job.accountId,
      });
    } catch (error) {
      this.logger.error({ err: error, notificationId }, 'Push delivery failed for a notification');
    }
  }

  /**
   * Emails, when the person's preferences and the deployment both allow it,
   * and never lets a mail failure fail the job — for the push path's reason:
   * a retry would find the row and send nothing.
   *
   * Only to a verified address of an active user. An unverified address is
   * one nobody has shown they read, and possibly somebody else's.
   */
  private async emailQuietly(job: NotificationJob, notificationId: string): Promise<void> {
    if (!this.mailer.configured) return;
    let domain = 'unknown';
    try {
      const decision = await this.push.deliveryFor(
        job.userId,
        categoryForKind(job.kind),
        new Date(),
      );
      if (!decision.email) return;
      const user = await this.prisma.user.findFirst({
        where: { id: job.userId },
        select: { email: true, emailVerified: true, isActive: true },
      });
      if (user === null || !user.emailVerified || !user.isActive) return;
      domain = user.email.slice(user.email.lastIndexOf('@') + 1);
      const account =
        job.accountId === null
          ? null
          : await this.prisma.account.findFirst({
              where: { id: job.accountId },
              select: { number: true },
            });
      const message = composeNotificationEmail({
        title: job.title,
        body: job.body,
        severity: job.severity,
        accountNumber: account?.number ?? null,
        appUrl: this.appUrl,
      });
      await this.mailer.send({ to: user.email, ...message });
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { emailedAt: new Date() },
      });
    } catch (error) {
      // The domain, never the address; the message, never the body.
      this.logger.error(
        { notificationId, domain, error: error instanceof Error ? error.message : String(error) },
        'A notification could not be emailed',
      );
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly mailer: NotificationMailer,
    private readonly appUrl: string = 'http://localhost:3000',
  ) {}
}

/** The producer's event id when there is one, the notification's id otherwise. */
export function eventIdOf(job: NotificationJob, notificationId: string): string {
  const declared = job.data['eventId'];
  return typeof declared === 'string' && declared.length > 0 ? declared : notificationId;
}

export interface NotificationJob {
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
