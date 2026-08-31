import { SOUND_FOR_CATEGORY } from '@tp/shared-types';
import type { NotificationCategory, TradingSound } from '@tp/shared-types';

/**
 * Whether to make a noise, and which one.
 *
 * Separated from the player because this is the part with rules and the player
 * is the part with a device. Every decision here is testable; nothing here
 * touches audio.
 */
export interface SoundPreferences {
  /** The master switch. */
  readonly soundEnabled: boolean;
  /** 0–100, applied by the in-app player. */
  readonly soundVolume: number;
  /** Per-category, as the server resolved them. */
  readonly perCategory: Readonly<Partial<Record<NotificationCategory, boolean>>>;
}

export interface SoundDecision {
  readonly sound: TradingSound | null;
  readonly volume: number;
  readonly reason:
    'play' | 'muted' | 'category-muted' | 'no-sound-for-category' | 'app-in-background';
}

/**
 * The one place the app decides to play something.
 *
 * ## Why background is a "no"
 *
 * When the app is backgrounded the *operating system* plays the notification
 * sound, from the push payload. If the app also played one on waking, a trader
 * with the app behind their browser would hear each fill twice — the classic
 * double-sound bug, and it looks like a duplicate-event failure when it is not.
 *
 * ## Why the server's category, not the local kind
 *
 * §18 requires that a modification sound differ from an opening, and the
 * mapping is part of the wire contract precisely so that three clients cannot
 * hold three opinions about it.
 */
export function decideSound(
  input: {
    category: NotificationCategory;
    /** False when the app is not in the foreground. */
    appActive: boolean;
    /** What the server said about this specific notification. */
    serverSaysPlay: boolean;
  },
  preferences: SoundPreferences,
): SoundDecision {
  const volume = clampVolume(preferences.soundVolume);

  if (!input.appActive) {
    return { sound: null, volume, reason: 'app-in-background' };
  }
  if (!preferences.soundEnabled || !input.serverSaysPlay) {
    return { sound: null, volume, reason: 'muted' };
  }
  if (preferences.perCategory[input.category] === false) {
    return { sound: null, volume, reason: 'category-muted' };
  }

  const sound = SOUND_FOR_CATEGORY[input.category];
  if (sound === null) {
    // SYSTEM has no sound. Not every notice deserves a noise, and an app that
    // beeps for everything is one whose users turn the sound off entirely —
    // which costs them the two or three that were worth hearing.
    return { sound: null, volume, reason: 'no-sound-for-category' };
  }

  return { sound, volume, reason: 'play' };
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0.8;
  return Math.min(1, Math.max(0, volume / 100));
}

/** The asset every sound maps to. Bundled with the app, not fetched. */
export const SOUND_ASSETS: Readonly<Record<TradingSound, string>> = {
  trade_opened: 'trade_opened.wav',
  trade_closed: 'trade_closed.wav',
  trade_modified: 'trade_modified.wav',
  order_filled: 'order_filled.wav',
  order_cancelled: 'order_cancelled.wav',
  stop_loss: 'stop_loss.wav',
  take_profit: 'take_profit.wav',
  risk_warning: 'risk_warning.wav',
};
