import { Injectable } from '@nestjs/common';
import {
  DomainError,
  NotificationCategory,
  TradingErrorCode,
  isUnmutable,
  type NotificationSettingsDto,
} from '@tp/shared-types';
import {
  DEFAULT_SETTINGS,
  describePreferences,
  resolveDelivery,
  type ResolvedDelivery,
  type StoredPreference,
  type StoredSettings,
} from '@tp/push-core';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What a person wants to be told, and how.
 *
 * ## The rule this file exists to enforce
 *
 * §24: *do not allow business-critical security notifications to be silently
 * disabled*. "Silently" is the load-bearing word. There are two ways to build
 * this and only one of them is honest: accept the change and ignore it at
 * delivery time, or refuse the change and say why. This refuses. A settings
 * screen showing a switch that is off while the notifications keep arriving is
 * worse than no switch at all — it teaches the user that the controls lie.
 *
 * ## Absent means default, not off
 *
 * A person who has never opened the settings screen has no rows. So does a
 * person for whom a *new* category was added yesterday. Both must receive that
 * category. Reading a missing row as `false` would mean every category added in
 * future is born muted for the entire existing user base, and nobody would
 * notice until an incident.
 *
 * ## Where the rules actually live
 *
 * `@tp/push-core`, not here. The worker delivers and this process serves the
 * settings screen; two implementations of the precedence rules would eventually
 * disagree, and that disagreement presents as exactly the lying switch above.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything a settings screen needs, defaults filled in. */
  async get(userId: string): Promise<NotificationSettingsDto> {
    const { settings, preferences } = await this.load(userId);
    return describePreferences(settings, preferences);
  }

  async updateSettings(
    userId: string,
    patch: Partial<StoredSettings>,
  ): Promise<NotificationSettingsDto> {
    if (
      (patch.quietHoursStartMinute ?? null) !== null &&
      (patch.quietHoursTimezone ?? null) === null
    ) {
      // Quiet hours without a timezone is not a preference, it is a bug waiting
      // for a traveller. Refused rather than assumed to be UTC — assuming would
      // silence a trader in Tehran between 03:00 and 10:00 local.
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'quietHoursTimezone is required when quiet hours are set',
      );
    }

    const tenantId = requireTenantId();
    await this.prisma.notificationSetting.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, ...patch },
      update: patch,
    });
    return this.get(userId);
  }

  /**
   * Change one category.
   *
   * Refuses rather than pretends. See the class comment.
   */
  async updateCategory(
    userId: string,
    category: NotificationCategory,
    patch: { inApp?: boolean; push?: boolean; sound?: boolean; email?: boolean },
  ): Promise<NotificationSettingsDto> {
    if (isUnmutable(category) && (patch.inApp === false || patch.push === false)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${category} notifications cannot be turned off. A margin call reaches you whether or not you asked for it.`,
      );
    }

    const tenantId = requireTenantId();
    await this.prisma.notificationPreference.upsert({
      where: { tenantId_userId_category: { tenantId, userId, category } },
      create: { tenantId, userId, category, ...patch },
      update: patch,
    });
    return this.get(userId);
  }

  /**
   * What the delivery path should actually do with one notification.
   *
   * `at` is injectable so the quiet-hours arithmetic is testable without
   * waiting for 3am.
   */
  async resolve(
    userId: string,
    category: NotificationCategory,
    at: Date = new Date(),
  ): Promise<ResolvedDelivery> {
    const { settings, preferences } = await this.load(userId);
    return resolveDelivery(
      settings,
      preferences.find((entry) => entry.category === category),
      category,
      at,
    );
  }

  private async load(
    userId: string,
  ): Promise<{ settings: StoredSettings; preferences: StoredPreference[] }> {
    const [row, rows] = await Promise.all([
      this.prisma.notificationSetting.findFirst({ where: { userId } }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
    ]);

    return {
      settings:
        row === null
          ? DEFAULT_SETTINGS
          : {
              tradingEnabled: row.tradingEnabled,
              pushEnabled: row.pushEnabled,
              soundEnabled: row.soundEnabled,
              vibrationEnabled: row.vibrationEnabled,
              soundVolume: row.soundVolume,
              quietHoursStartMinute: row.quietHoursStartMinute,
              quietHoursEndMinute: row.quietHoursEndMinute,
              quietHoursTimezone: row.quietHoursTimezone,
            },
      preferences: rows.map((entry) => ({
        category: entry.category as NotificationCategory,
        inApp: entry.inApp,
        push: entry.push,
        sound: entry.sound,
        email: entry.email,
      })),
    };
  }
}
