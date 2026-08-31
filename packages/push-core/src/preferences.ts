import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  isUnmutable,
  type NotificationPreferenceDto,
  type NotificationSettingsDto,
} from '@tp/shared-types';

/**
 * Whether one notification should be shown, pushed, emailed and sounded.
 *
 * Pure, and shared by the API (which serves the settings screen) and the worker
 * (which delivers). Two implementations of these rules would eventually
 * disagree, and the way that failure presents is a settings screen that says
 * push is off while the phone keeps buzzing — which is the exact thing §24
 * forbids.
 */
export interface ResolvedDelivery {
  readonly inApp: boolean;
  readonly push: boolean;
  readonly email: boolean;
  /** Whether the client should play this category's sound. */
  readonly sound: boolean;
}

export interface StoredPreference {
  readonly category: NotificationCategory;
  readonly inApp: boolean;
  readonly push: boolean;
  readonly sound: boolean;
  readonly email: boolean;
}

export interface StoredSettings {
  readonly tradingEnabled: boolean;
  readonly pushEnabled: boolean;
  readonly soundEnabled: boolean;
  readonly vibrationEnabled: boolean;
  readonly soundVolume: number;
  readonly quietHoursStartMinute: number | null;
  readonly quietHoursEndMinute: number | null;
  readonly quietHoursTimezone: string | null;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  tradingEnabled: true,
  pushEnabled: true,
  soundEnabled: true,
  vibrationEnabled: true,
  soundVolume: 80,
  quietHoursStartMinute: null,
  quietHoursEndMinute: null,
  quietHoursTimezone: null,
};

export function defaultPreference(category: NotificationCategory): StoredPreference {
  return { category, inApp: true, push: true, sound: true, email: false };
}

/**
 * The precedence rules, in one place.
 *
 *   1. An unmutable category is delivered in-app and by push, always.
 *   2. Otherwise the master switches win over the per-category ones, so turning
 *      push off means off without rewriting ten rows and without losing what
 *      those rows said.
 *   3. Quiet hours withhold *push* only, and never for an unmutable category.
 *      A stop-out at three in the morning is exactly the notification a person
 *      set quiet hours to avoid and exactly the one they need.
 */
export function resolveDelivery(
  settings: StoredSettings,
  preference: StoredPreference | undefined,
  category: NotificationCategory,
  at: Date = new Date(),
): ResolvedDelivery {
  const effective = preference ?? defaultPreference(category);

  if (isUnmutable(category)) {
    return {
      inApp: true,
      push: true,
      email: effective.email,
      sound: settings.soundEnabled && effective.sound,
    };
  }

  const allowed = settings.tradingEnabled;
  const quiet = inQuietHours(settings, at);

  return {
    inApp: allowed && effective.inApp,
    push: allowed && settings.pushEnabled && effective.push && !quiet,
    email: allowed && effective.email,
    sound: allowed && settings.soundEnabled && effective.sound,
  };
}

/** The settings screen's view: every category, defaults filled in. */
export function describePreferences(
  settings: StoredSettings,
  stored: readonly StoredPreference[],
): NotificationSettingsDto {
  const byCategory = new Map(stored.map((row) => [row.category, row]));

  const categories: NotificationPreferenceDto[] = NOTIFICATION_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    const unmutable = isUnmutable(category);
    return {
      category,
      // An unmutable category reports itself on regardless of what is stored,
      // because that is what will actually happen when one is raised. A switch
      // that shows "off" while the notices arrive teaches people the controls
      // lie.
      inApp: unmutable ? true : (row?.inApp ?? true),
      push: unmutable ? true : (row?.push ?? true),
      sound: row?.sound ?? true,
      email: row?.email ?? false,
      unmutable,
    };
  });

  return { ...settings, categories };
}

/**
 * Is `at` inside the user's quiet hours?
 *
 * Handles the range that wraps midnight, which is the common case: 22:00 to
 * 07:00 is `start > end`, and treating it as an empty range would make quiet
 * hours do nothing for almost everyone who sets them — silently, with the only
 * symptom being a phone that keeps buzzing at night.
 */
export function inQuietHours(
  settings: Pick<
    StoredSettings,
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
 * `Intl` rather than a stored offset: offsets change twice a year in most of
 * the world, and a stored one is wrong for half of it. An unknown zone returns
 * null so the caller treats quiet hours as unset rather than throwing inside a
 * notification.
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
    // Intl renders midnight as 24 under some locales' 2-digit hour cycle.
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}
