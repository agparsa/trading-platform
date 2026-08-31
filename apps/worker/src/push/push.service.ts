import { Injectable, Logger } from '@nestjs/common';
import { PushOutcome, resolveDelivery, DEFAULT_SETTINGS } from '@tp/push-core';
import type { StoredPreference, StoredSettings } from '@tp/push-core';
import { DevicePlatform, categoryForKind, type NotificationCategory } from '@tp/shared-types';
import { SecretBox } from '@tp/crypto-core';
import { PrismaService } from '../prisma.service';
import { PushProvider, type PushEnvelope } from './push.port';

/**
 * Sends one notification to a person's devices.
 *
 * ## Called once per notification *row*, never per event
 *
 * The caller is `NotificationsService.deliver`, and it calls this only when it
 * actually inserted a row. That single condition is what satisfies §26 for the
 * whole platform: the notification table's `dedupeKey` already collapses two
 * producers noticing the same thing into one row, so a second delivery attempt
 * finds the row already there, returns `created: false`, and never reaches
 * here. No separate push-side deduplication is needed, and adding one would be
 * a second mechanism that could disagree with the first.
 *
 * ## Every outcome is recorded
 *
 * Including the ones where nothing was sent. §36 asks the Admin panel for
 * delivery statistics, and statistics that only count attempts cannot answer
 * the question an operator actually has — "why did this person not get it?" —
 * whose commonest answer is "they turned it off", not "it failed".
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PushProvider,
    private readonly secrets: SecretBox,
  ) {}

  async deliver(input: {
    tenantId: string;
    userId: string;
    notificationId: string;
    eventId: string;
    kind: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    body: string;
    accountId: string | null;
    at?: Date;
  }): Promise<PushSummary> {
    const category = categoryForKind(input.kind);
    const decision = await this.decide(input.userId, category, input.at ?? new Date());

    const devices = await this.prisma.device.findMany({
      where: {
        userId: input.userId,
        isActive: true,
        pushToken: { not: null },
        pushTokenRejectedAt: null,
      },
      select: { id: true, platform: true, installationId: true, pushToken: true },
    });

    if (!decision.push) {
      // Recorded rather than dropped: "we chose not to" and "we tried and
      // failed" are different answers to the same support question, and only
      // one of them is a bug.
      for (const device of devices) {
        await this.record(input, device.id, PushOutcome.NOT_CONFIGURED, 'PREFERENCE', null, {
          skippedByPreference: true,
        });
      }
      return { attempted: 0, sent: 0, skipped: devices.length, failed: 0, dropped: 0 };
    }

    const summary: PushSummary = {
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      dropped: 0,
    };

    for (const device of devices) {
      if (device.pushToken === null) continue;

      let token: string;
      try {
        token = this.secrets.open(
          device.pushToken,
          `device:${input.userId}:${device.installationId}`,
        );
      } catch (error) {
        // A token sealed under a retired key cannot be recovered. Skipping is
        // right; failing the whole fan-out would silence every other device
        // this person owns.
        this.logger.error(
          { err: error, deviceId: device.id },
          'Could not open a stored push token',
        );
        summary.failed += 1;
        await this.record(input, device.id, PushOutcome.PERMANENT, 'UNREADABLE_TOKEN', null, {});
        continue;
      }

      const envelope: PushEnvelope = {
        deviceId: device.id,
        platform: device.platform as DevicePlatform,
        token,
        title: input.title,
        body: input.body,
        category,
        severity: input.severity,
        notificationId: input.notificationId,
        eventId: input.eventId,
        accountId: input.accountId,
        playSound: decision.sound,
      };

      summary.attempted += 1;
      const result = await this.provider.send(envelope);
      await this.record(
        input,
        device.id,
        result.outcome,
        result.errorCode,
        result.providerMessageId,
        {},
      );

      switch (result.outcome) {
        case PushOutcome.SENT:
          summary.sent += 1;
          break;
        case PushOutcome.DROP_TOKEN:
          summary.dropped += 1;
          /**
           * The provider says this token is dead, so stop using it.
           *
           * Recorded rather than cleared: "stopped receiving on the 3rd,
           * because the provider said the app was uninstalled" is a supportable
           * answer, and a row that quietly lost its token is not.
           */
          await this.prisma.device.updateMany({
            where: { id: device.id },
            data: { pushTokenRejectedAt: new Date() },
          });
          break;
        case PushOutcome.NOT_CONFIGURED:
          summary.skipped += 1;
          break;
        default:
          summary.failed += 1;
          break;
      }
    }

    return summary;
  }

  /** What the user's settings say about this category. */
  private async decide(userId: string, category: NotificationCategory, at: Date) {
    const [settingsRow, preferenceRows] = await Promise.all([
      this.prisma.notificationSetting.findFirst({ where: { userId } }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
    ]);

    const settings: StoredSettings =
      settingsRow === null
        ? DEFAULT_SETTINGS
        : {
            tradingEnabled: settingsRow.tradingEnabled,
            pushEnabled: settingsRow.pushEnabled,
            soundEnabled: settingsRow.soundEnabled,
            vibrationEnabled: settingsRow.vibrationEnabled,
            soundVolume: settingsRow.soundVolume,
            quietHoursStartMinute: settingsRow.quietHoursStartMinute,
            quietHoursEndMinute: settingsRow.quietHoursEndMinute,
            quietHoursTimezone: settingsRow.quietHoursTimezone,
          };

    const preference: StoredPreference | undefined = preferenceRows
      .map((row) => ({
        category: row.category as NotificationCategory,
        inApp: row.inApp,
        push: row.push,
        sound: row.sound,
        email: row.email,
      }))
      .find((row) => row.category === category);

    return resolveDelivery(settings, preference, category, at);
  }

  /**
   * Writes the attempt down.
   *
   * Upserted on (notification, device) so a retried job updates the attempt
   * rather than writing a second row — the count of rows stays the count of
   * intended deliveries, which is what makes the admin figures mean anything.
   */
  private async record(
    input: { tenantId: string; notificationId: string },
    deviceId: string,
    outcome: PushOutcome,
    errorCode: string | null,
    providerMessageId: string | null,
    options: { skippedByPreference?: boolean },
  ): Promise<void> {
    const status =
      options.skippedByPreference === true
        ? 'SKIPPED'
        : outcome === PushOutcome.SENT
          ? 'SENT'
          : outcome === PushOutcome.DROP_TOKEN
            ? 'DROPPED'
            : outcome === PushOutcome.NOT_CONFIGURED
              ? 'SKIPPED'
              : 'FAILED';

    try {
      await this.prisma.pushDelivery.upsert({
        where: {
          notificationId_deviceId: { notificationId: input.notificationId, deviceId },
        },
        create: {
          tenantId: input.tenantId,
          notificationId: input.notificationId,
          deviceId,
          status,
          attempts: 1,
          errorCode,
          providerMessageId,
          sentAt: status === 'SENT' ? new Date() : null,
        },
        update: {
          status,
          attempts: { increment: 1 },
          errorCode,
          providerMessageId,
          ...(status === 'SENT' ? { sentAt: new Date() } : {}),
        },
      });
    } catch (error) {
      // A delivery record that could not be written must not fail the
      // notification. The notice reached the phone; losing the statistic is
      // strictly better than losing the notice.
      this.logger.error({ err: error, deviceId }, 'Could not record a push delivery');
    }
  }
}

export interface PushSummary {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  dropped: number;
}
