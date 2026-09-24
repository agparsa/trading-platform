import { NOTIFICATION_CATEGORIES, NotificationCategory } from '@tp/shared-types';
import { SeenEvents } from './seen-events';
import { decideSound, type SoundPreferences } from './sound-decision';
import { decideHaptic, silentHaptics, type HapticPort } from './haptics';
import type { SoundPlayerPort } from './sound-player';

/**
 * One trading event arriving from anywhere, handled once.
 *
 * ## The two routes in
 *
 * A push notification received in the foreground, and a push the trader tapped
 * from the lock screen. Both describe the same occurrence and carry the same
 * `eventId`, so both come through here and the first one wins.
 *
 * The socket frame for the same fill is **not** a third route, though this
 * said it was and typed `source: 'socket'` for it. Nothing ever sent a frame
 * here. It does not now either, on purpose: the frame carries no word from the
 * server on whether this notification should sound, and a frame claiming the
 * event first would make the push that does carry it a duplicate. Frames
 * refresh the screens instead — see `LiveProvider`.
 *
 * ## Why this is not in a React component
 *
 * Because a component unmounts. A trader who switches from the positions tab to
 * the chart while an order fills must still hear it, and the handler that
 * decides must outlive any screen.
 */
export interface IncomingTradingEvent {
  readonly eventId: string;
  /**
   * The category the server resolved, as the push carries it.
   *
   * This was a `kind` — `'position.opened'` — mapped here with
   * `categoryForKind`. No push has ever carried a kind: the payload names the
   * category. So every push arrived with `kind: ''`, which maps to `SYSTEM`,
   * which has no sound and no haptic — and a fill received with the app open
   * made no noise and no buzz, on every phone, whatever the settings said.
   * `trading-events.test.ts` now builds real push payloads with
   * `@tp/push-core` and runs them through `toTradingEvent`.
   */
  readonly category: NotificationCategory;
  readonly accountId: string | null;
  /** What the server decided about the sound for this specific notification. */
  readonly playSound: boolean;
  readonly source: 'push-foreground' | 'push-tapped';
}

/**
 * Reads a push's custom data — FCM's `data`, or the keys beside `aps` — into
 * an event, or `null` when it is not one of ours.
 *
 * A category this build does not know is read as `SYSTEM` rather than
 * dropped: a notice the server added after this app was built still reaches
 * the handler, silently, instead of vanishing.
 */
export function toTradingEvent(
  data: unknown,
  source: IncomingTradingEvent['source'],
): IncomingTradingEvent | null {
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const eventId = record['eventId'];
  const category = record['category'];
  if (typeof eventId !== 'string' || eventId.length === 0 || typeof category !== 'string') {
    return null;
  }
  return {
    eventId,
    category: (NOTIFICATION_CATEGORIES as readonly string[]).includes(category)
      ? (category as NotificationCategory)
      : NotificationCategory.SYSTEM,
    accountId: typeof record['accountId'] === 'string' ? record['accountId'] : null,
    // A payload with no `sound` key is one the server decided should be silent.
    playSound: typeof record['sound'] === 'string',
    source,
  };
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
    const { category } = event;

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
