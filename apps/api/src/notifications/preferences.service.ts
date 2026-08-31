import { Injectable } from '@nestjs/common';
import {
  DomainError,
  NOTIFICATION_CATEGORIES,
  NotificationCategory,
  TradingErrorCode,
  isUnmutable,
  type NotificationPreferenceDto,
  type NotificationSettingsDto,
} from '@tp/shared-types';
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
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything a settings screen needs, defaults filled in. */
  async get(userId: string): Promise<NotificationSettingsDto> {
    const [settings, rows] = await Promise.all([
      this.prisma.notificationSetting.findFirst({ where: { userId } }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
    ]);

    const byCategory = new Map(rows.map((row) => [row.category as NotificationCategory, row]));

    const categories: NotificationPreferenceDto[] = NOTIFICATION_CATEGORIES.map((category) => {
      const row = byCategory.get(category);
      const unmutable = isUnmutable(category);
      return {
        category,
        // An unmutable category reports itself on regardless of what is stored,
        // because that is what will actually happen when one is raised.
        inApp: unmutable ? true : (row?.inApp ?? true),
        push: unmutable ? true : (row?.push ?? true),
        sound: row?.sound ?? true,
        email: row?.email ?? false,
        unmutable,
      };
    });

    return {
      tradingEnabled: settings?.tradingEnabled ?? true,
      pushEnabled: settings?.pushEnabled ?? true,
      soundEnabled: settings?.soundEnabled ?? true,
      vibrationEnabled: settings?.vibrationEnabled ?? true,
      soundVolume: settings?.soundVolume ?? 80,
      quietHoursStartMinute: settings?.quietHoursStartMinute ?? null,
      quietHoursEndMinute: settings?.quietHoursEndMinute ?? null,
      quietHoursTimezone: settings?.quietHoursTimezone ?? null,
      categories,
    };
  }

  async updateSettings(
    userId: string,
    patch: {
      tradingEnabled?: boolean;
      pushEnabled?: boolean;
      soundEnabled?: boolean;
      vibrationEnabled?: boolean;
      soundVolume?: number;
      quietHoursStartMinute?: number | null;
      quietHoursEndMinute?: number | null;
      quietHoursTimezone?: string | null;
    },
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
   * The single place the precedence rules live, so the in-app writer, the push
   * fan-out and the client's sound decision cannot disagree about them:
   *
   *   1. An unmutable category is delivered in-app and by push, always.
   *   2. Otherwise the master switches win over the per-category ones — turning
   *      push off means off, without rewriting ten rows.
   *   3. Quiet hours withhold *push* only, and never for an unmutable category.
   *      A stop-out at three in the morning is exactly the notification a person
   *      set quiet hours to avoid and exactly the one they need.
   *
   * `at` is injectable so the quiet-hours arithmetic is testable without
   * waiting for 3am.
   */
  async resolve(
    userId: string,
    category: NotificationCategory,
    at: Date = new Date(),
  ): Promise<ResolvedDelivery> {
    const settings = await this.get(userId);
    const preference =
      settings.categories.find((entry) => entry.category === category) ?? FALLBACK(category);
    const unmutable = isUnmutable(category);

    if (unmutable) {
      return {
        inApp: true,
        push: true,
        email: preference.email,
        sound: settings.soundEnabled && preference.sound,
      };
    }

    const allowed = settings.tradingEnabled;
    const quiet = inQuietHours(settings, at);

    return {
      inApp: allowed && preference.inApp,
      push: allowed && settings.pushEnabled && preference.push && !quiet,
      email: allowed && preference.email,
      sound: allowed && settings.soundEnabled && preference.sound,
    };
  }
}

export interface ResolvedDelivery {
  inApp: boolean;
  push: boolean;
  email: boolean;
  /** Whether the client should play this category's sound. */
  sound: boolean;
}

const FALLBACK = (category: NotificationCategory): NotificationPreferenceDto => ({
  category,
  inApp: true,
  push: true,
  sound: true,
  email: false,
  unmutable: isUnmutable(category),
});

/**
 * Is `at` inside the user's quiet hours?
 *
 * Handles the range that wraps midnight, which is the common case: 22:00 to
 * 07:00 is `start > end`, and treating it as an empty range would make quiet
 * hours do nothing for almost everyone who sets them.
 */
export function inQuietHours(
  settings: Pick<
    NotificationSettingsDto,
    'quietHoursStartMinute' | 'quietHoursEndMinute' | 'quietHoursTimezone'
  >,
  at: Date,
): boolean {
  const { quietHoursStartMinute: start, quietHoursEndMinute: end, quietHoursTimezone } = settings;
  if (start === null || end === null || quietHoursTimezone === null) return false;
  if (start === end) return false;

  const minutes = minutesOfDayIn(at, quietHoursTimezone);
  if (minutes === null) return false;

  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Minutes since midnight in a named timezone, or null if the zone is unknown.
 *
 * Uses `Intl` rather than an offset table: offsets change twice a year in most
 * of the world, and a stored offset is wrong for half of it. An unknown zone
 * returns null so the caller treats quiet hours as unset rather than throwing
 * inside a notification.
 */
function minutesOfDayIn(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    // Intl renders midnight as 24 in some locales' 2-digit hour cycle.
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}
