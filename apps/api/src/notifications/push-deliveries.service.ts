import { Injectable } from '@nestjs/common';
import type { Prisma, PushDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reading what the platform tried to tell people, and whether it got through.
 *
 * The worker writes one `push_deliveries` row per notification per device
 * (`apps/worker/src/push/push.service.ts`), and `docs/notifications.md` has
 * said since that phase that "the admin view says sent rather than delivered".
 * There was no admin view. The rows were written and read by nobody — a
 * statistic that costs storage and answers no question, which is the audit
 * log's story again, one table over.
 *
 * ## Read-only, by construction
 *
 * No write path. A delivery record is what happened; the worker is the only
 * writer, and an operator who could edit one could make a failed alert look
 * sent. What an operator *does* about a dead token is on the device — revoke
 * or restore it, under `users.manage` — not here.
 *
 * ## Three answers to "I never got it"
 *
 * `SKIPPED` — the person's preferences excluded the device, or push is not
 * configured; nothing was tried. `SENT` — the provider accepted the message;
 * no provider can say whether the phone showed it, so the word is "sent".
 * `FAILED` — the provider refused and the reason may pass. `DROPPED` — the
 * provider says the token is dead; the device was marked accordingly. Only the
 * last two are a fault, and the error code is the provider's own word for it,
 * verbatim, because a code this platform has never seen must still be shown.
 */
@Injectable()
export class PushDeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: {
    status?: PushDeliveryStatus;
    userId?: string;
    kind?: string;
    errorCode?: string;
    since?: Date;
    limit?: number;
  }): Promise<readonly PushDeliveryView[]> {
    const where: Prisma.PushDeliveryWhereInput = {};
    if (filter.status !== undefined) where.status = filter.status;
    if (filter.errorCode !== undefined) where.errorCode = filter.errorCode;
    if (filter.since !== undefined) where.createdAt = { gte: filter.since };
    if (filter.userId !== undefined || filter.kind !== undefined) {
      where.notification = {
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
        // Prefix match, anchored: `order.` finds every order notice. A substring
        // search over a growing table is a sequential scan waiting to happen.
        ...(filter.kind === undefined ? {} : { kind: { startsWith: filter.kind } }),
      };
    }

    const rows = await this.prisma.pushDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: clamp(filter.limit, 100, 500),
      select: {
        id: true,
        status: true,
        attempts: true,
        errorCode: true,
        providerMessageId: true,
        sentAt: true,
        createdAt: true,
        updatedAt: true,
        notification: {
          select: {
            id: true,
            kind: true,
            severity: true,
            title: true,
            createdAt: true,
            user: { select: { id: true, email: true } },
          },
        },
        /**
         * The token itself is never selected. It is sealed at rest and would be
         * useless on a screen; a fingerprint is what a support conversation
         * needs to tell two devices apart, and the model is what the person
         * will recognise.
         */
        device: {
          select: {
            id: true,
            platform: true,
            model: true,
            appVersion: true,
            isActive: true,
            pushTokenFingerprint: true,
            pushTokenRejectedAt: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.errorCode,
      providerMessageId: row.providerMessageId,
      sentAt: row.sentAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      notification: {
        id: row.notification.id,
        kind: row.notification.kind,
        severity: row.notification.severity,
        title: row.notification.title,
        createdAt: row.notification.createdAt.toISOString(),
        userId: row.notification.user.id,
        userEmail: row.notification.user.email,
      },
      device: {
        id: row.device.id,
        platform: row.device.platform,
        model: row.device.model,
        appVersion: row.device.appVersion,
        isActive: row.device.isActive,
        tokenFingerprint: row.device.pushTokenFingerprint,
        tokenRejectedAt: row.device.pushTokenRejectedAt?.toISOString() ?? null,
      },
    }));
  }

  /**
   * The figures, over a window: how many of each outcome, which error codes
   * and how often, and the split by platform. Counted from the same rows the
   * list shows, so the tiles and the table cannot disagree.
   */
  async summary(since: Date): Promise<PushDeliverySummary> {
    const [byStatus, byError, byPlatform] = await Promise.all([
      this.prisma.pushDelivery.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.pushDelivery.groupBy({
        by: ['errorCode'],
        where: { createdAt: { gte: since }, errorCode: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { errorCode: 'desc' } },
        take: 20,
      }),
      this.prisma.pushDelivery.findMany({
        where: { createdAt: { gte: since } },
        select: { status: true, device: { select: { platform: true } } },
      }),
    ]);

    const counts: PushDeliverySummary['counts'] = {
      PENDING: 0,
      SENT: 0,
      FAILED: 0,
      DROPPED: 0,
      SKIPPED: 0,
    };
    for (const row of byStatus) counts[row.status] = row._count._all;

    const platforms = new Map<string, { attempted: number; sent: number }>();
    for (const row of byPlatform) {
      const entry = platforms.get(row.device.platform) ?? { attempted: 0, sent: 0 };
      entry.attempted += 1;
      if (row.status === 'SENT') entry.sent += 1;
      platforms.set(row.device.platform, entry);
    }

    return {
      since: since.toISOString(),
      total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      counts,
      errors: byError
        .filter((row): row is typeof row & { errorCode: string } => row.errorCode !== null)
        .map((row) => ({ code: row.errorCode, count: row._count._all })),
      platforms: [...platforms.entries()]
        .map(([platform, figures]) => ({ platform, ...figures }))
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    };
  }
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(value ?? fallback, 1), max);

export interface PushDeliveryView {
  readonly id: string;
  readonly status: PushDeliveryStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly providerMessageId: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly notification: {
    readonly id: string;
    readonly kind: string;
    readonly severity: string;
    readonly title: string;
    readonly createdAt: string;
    readonly userId: string;
    readonly userEmail: string;
  };
  readonly device: {
    readonly id: string;
    readonly platform: string;
    readonly model: string | null;
    readonly appVersion: string | null;
    readonly isActive: boolean;
    readonly tokenFingerprint: string | null;
    readonly tokenRejectedAt: string | null;
  };
}

export interface PushDeliverySummary {
  readonly since: string;
  readonly total: number;
  readonly counts: Record<PushDeliveryStatus, number>;
  readonly errors: ReadonlyArray<{ code: string; count: number }>;
  readonly platforms: ReadonlyArray<{ platform: string; attempted: number; sent: number }>;
}
