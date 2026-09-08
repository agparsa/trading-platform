import { categoryForKind } from '@tp/shared-types';
import type { NotificationCategory } from '@tp/shared-types';
import { SeenEvents } from './seen-events';
import { decideSound, type SoundPreferences } from './sound-decision';
import { decideHaptic, silentHaptics, type HapticPort } from './haptics';
import type { SoundPlayerPort } from './sound-player';

/**
 * One trading event arriving from anywhere, handled once.
 *
 * ## The three routes in
 *
 * A WebSocket frame while the app is open; a push notification received in the
 * foreground; a push the trader tapped from the lock screen. All three describe
 * the same occurrence and all three carry the same `eventId`, so all three come
 * through here and the first one wins.
 *
 * ## Why this is not in a React component
 *
 * Because a component unmounts. A trader who switches from the positions tab to
 * the chart while an order fills must still hear it, and the handler that
 * decides must outlive any screen.
 */
export interface IncomingTradingEvent {
  readonly eventId: string;
  /** The server's machine name, e.g. 'position.opened'. */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly accountId: string | null;
  /** What the server decided about the sound for this specific notification. */
  readonly playSound: boolean;
  readonly source: 'socket' | 'push-foreground' | 'push-tapped';
}

export interface HandledEvent {
  readonly eventId: string;
  readonly category: NotificationCategory;
  readonly playedSound: string | null;
  /** The pattern the device was asked for, or null if it stayed still. */
  readonly vibrated: string | null;
  readonly duplicate: boolean;
}

export class TradingEventHandler {
  constructor(
    private readonly sounds: SoundPlayerPort,
    private readonly seen: SeenEvents = new SeenEvents(),
    /**
     * Defaulted, so every existing caller keeps working and a build without the
     * native module behaves like a device with haptics turned off — a state the
     * app already handles.
     */
    private readonly haptics: HapticPort = silentHaptics,
  ) {}

  private preferences: SoundPreferences = {
    soundEnabled: true,
    soundVolume: 80,
    perCategory: {},
  };

  /**
   * Its own switch, sharing the per-category ones.
   *
   * A trader in a meeting turns sound off and wants to keep feeling fills;
   * a trader who muted "modifications" meant it in both senses. So the master
   * switches are separate and the category switches are not.
   */
  private hapticsEnabled = true;

  /** Called when the settings screen loads or the user changes something. */
  setPreferences(preferences: SoundPreferences & { hapticsEnabled?: boolean }): void {
    this.preferences = preferences;
    if (preferences.hapticsEnabled !== undefined) {
      this.hapticsEnabled = preferences.hapticsEnabled;
    }
  }

  /**
   * Handles one event.
   *
   * Returns what it did, so the caller can update state and a debug screen can
   * show why a sound did or did not play — which is the question support gets.
   */
  handle(event: IncomingTradingEvent, appActive: boolean): HandledEvent {
    const category = categoryForKind(event.kind);

    if (!this.seen.claim(event.eventId)) {
      return {
        eventId: event.eventId,
        category,
        playedSound: null,
        vibrated: null,
        duplicate: true,
      };
    }

    /**
     * A tapped notification never plays a sound.
     *
     * The OS already made one when it arrived, and the trader is now looking at
     * the screen. Playing it again on the tap is the second half of the
     * double-sound bug.
     */
    const decision = decideSound(
      {
        category,
        appActive: appActive && event.source !== 'push-tapped',
        serverSaysPlay: event.playSound,
      },
      this.preferences,
    );

    if (decision.sound !== null) {
      this.sounds.play(decision.sound, decision.volume);
    }

    /**
     * Decided separately from the sound, on the same inputs.
     *
     * Not derived from whether a sound played: a trader with sound off in a
     * meeting still wants to feel a fill, and deriving one from the other would
     * silently take that away.
     */
    const feel = decideHaptic(
      {
        category,
        appActive: appActive && event.source !== 'push-tapped',
        serverSaysNotify: event.playSound,
      },
      { hapticsEnabled: this.hapticsEnabled, perCategory: this.preferences.perCategory },
    );
    if (feel.haptic !== null) {
      this.haptics.vibrate(feel.haptic);
    }

    return {
      eventId: event.eventId,
      category,
      playedSound: decision.sound,
      vibrated: feel.haptic,
      duplicate: false,
    };
  }

  /** On sign-out. One person's events must not be another's. */
  reset(): void {
    this.seen.clear();
  }
}
