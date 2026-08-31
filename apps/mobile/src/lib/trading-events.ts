import { categoryForKind } from '@tp/shared-types';
import type { NotificationCategory } from '@tp/shared-types';
import { SeenEvents } from './seen-events';
import { decideSound, type SoundPreferences } from './sound-decision';
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
  readonly duplicate: boolean;
}

export class TradingEventHandler {
  constructor(
    private readonly sounds: SoundPlayerPort,
    private readonly seen: SeenEvents = new SeenEvents(),
  ) {}

  private preferences: SoundPreferences = {
    soundEnabled: true,
    soundVolume: 80,
    perCategory: {},
  };

  /** Called when the settings screen loads or the user changes something. */
  setPreferences(preferences: SoundPreferences): void {
    this.preferences = preferences;
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
      return { eventId: event.eventId, category, playedSound: null, duplicate: true };
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

    return {
      eventId: event.eventId,
      category,
      playedSound: decision.sound,
      duplicate: false,
    };
  }

  /** On sign-out. One person's events must not be another's. */
  reset(): void {
    this.seen.clear();
  }
}
