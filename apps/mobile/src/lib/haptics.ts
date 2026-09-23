import { HAPTIC_FOR_CATEGORY } from '@tp/shared-types';
import type { NotificationCategory, TradingHaptic } from '@tp/shared-types';

/**
 * Whether to vibrate, and how.
 *
 * Split from the device the same way `sound-decision` is split from
 * `sound-player`: this is the part with rules and is entirely testable; the
 * port below is the part that touches hardware.
 */
export interface HapticPreferences {
  /** The master switch. */
  readonly hapticsEnabled: boolean;
  /**
   * Per-category, as the server resolved them — the *same* preferences that
   * govern sound.
   *
   * One switch per category, not two. A trader who has said "don't tell me
   * about modifications" has said it once; offering them a second switch to say
   * it again in a different sense is an interface that invites a phone to buzz
   * for something the trader believes they turned off.
   */
  readonly perCategory: Readonly<Partial<Record<NotificationCategory, boolean>>>;
}

export interface HapticDecision {
  readonly haptic: TradingHaptic | null;
  readonly reason:
    'vibrate' | 'muted' | 'category-muted' | 'no-haptic-for-category' | 'app-in-background';
}

/**
 * The one place the app decides to vibrate.
 *
 * ## Why background is a "no"
 *
 * The operating system already vibrates for a push notification. If the app
 * also vibrated on waking, a trader would feel each fill twice — the same
 * double-feedback bug the sound path avoids, and it is even harder to notice as
 * a bug because a double buzz just feels like a long one.
 *
 * ## Why a tapped notification is a "no"
 *
 * The phone buzzed when it arrived and the trader is now holding it and looking
 * at the screen. Vibrating again tells them nothing they are not already doing.
 */
export function decideHaptic(
  input: {
    category: NotificationCategory;
    appActive: boolean;
    serverSaysNotify: boolean;
  },
  preferences: HapticPreferences,
): HapticDecision {
  if (!input.appActive) return { haptic: null, reason: 'app-in-background' };
  if (!preferences.hapticsEnabled || !input.serverSaysNotify) {
    return { haptic: null, reason: 'muted' };
  }
  if (preferences.perCategory[input.category] === false) {
    return { haptic: null, reason: 'category-muted' };
  }

  const haptic = HAPTIC_FOR_CATEGORY[input.category];
  if (haptic === null) return { haptic: null, reason: 'no-haptic-for-category' };
  return { haptic, reason: 'vibrate' };
}

/**
 * The device.
 *
 * A port rather than a direct call to `expo-haptics`, for the same reason the
 * sound player is one: the decision above must be testable on a machine with no
 * phone attached, and a simulator with no haptic engine must be a no-op rather
 * than a crash.
 */
export interface HapticPort {
  vibrate(haptic: TradingHaptic): void;
}

/**
 * The default until a real one is installed.
 *
 * Silent rather than absent: every caller can hold a port and none of them has
 * to check for null, and a build without the native module behaves like a
 * device with the feature turned off — which is a state the app already handles
 * correctly.
 */
export const silentHaptics: HapticPort = {
  vibrate: () => undefined,
};
