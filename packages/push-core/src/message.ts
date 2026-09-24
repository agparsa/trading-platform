import {
  DevicePlatform,
  type NotificationCategory,
  SOUND_FOR_CATEGORY,
  type TradingSound,
  androidChannelFor,
} from '@tp/shared-types';

/**
 * The FCM HTTP v1 message body, as the API actually defines it.
 *
 * Written out rather than taken from an SDK so that the shape this platform
 * sends is reviewable in one file, and so a field name is checked by the
 * compiler instead of by production. Field names are snake_case inside the
 * platform blocks and camelCase at the top level because that is what the API
 * documents — an inconsistency in Google's contract, not in ours.
 *
 * Reference: firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
 */
export interface FcmMessage {
  readonly token: string;
  readonly notification: { readonly title: string; readonly body: string };
  /**
   * FCM requires every data value to be a string. Numbers and booleans are
   * stringified at construction rather than trusted to JSON.stringify, because
   * a nested object here is rejected by the API with a message that does not
   * name the field.
   */
  readonly data: Readonly<Record<string, string>>;
  readonly android?: {
    readonly priority: 'HIGH' | 'NORMAL';
    readonly notification: {
      readonly channel_id: string;
      readonly sound?: string;
      readonly notification_priority?: 'PRIORITY_HIGH' | 'PRIORITY_DEFAULT';
      readonly default_sound?: boolean;
    };
  };
  readonly apns?: {
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: {
      readonly aps: {
        readonly sound?: string;
        readonly 'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical';
      };
    };
  };
  readonly webpush?: {
    readonly headers: Readonly<Record<string, string>>;
  };
}

export interface PushRequest {
  readonly token: string;
  readonly platform: DevicePlatform;
  readonly title: string;
  readonly body: string;
  readonly category: NotificationCategory;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  /** The row in `notifications` this push is a copy of. */
  readonly notificationId: string;
  /**
   * The occurrence, not the notification.
   *
   * §26: the client processes each `eventId` once. A push received in the
   * foreground and the same push tapped later are one event, and must not
   * play the sound twice — so both carry this. The socket frame for the same
   * occurrence carries it too, and the phone keeps that one in a separate
   * memory on purpose: see `apps/mobile/src/lib/live.tsx`.
   */
  readonly eventId: string;
  readonly accountId: string | null;
  /** False when the user has this category's sound off. */
  readonly playSound: boolean;
}

/** FCM rejects a message whose payload exceeds this. */
export const FCM_MAX_PAYLOAD_BYTES = 4096;

/**
 * Builds the message for one device.
 *
 * The sound is named in three places because the three platforms decide it in
 * three places: Android reads the notification channel and the `sound` field,
 * iOS reads `aps.sound`, and a foreground client reads `data.sound` and plays
 * it itself. Omitting any one of them produces a notification that is silent on
 * exactly one platform — the kind of bug that ships because the developer tests
 * on the other two.
 */
export function buildFcmMessage(request: PushRequest): FcmMessage {
  const sound = request.playSound ? SOUND_FOR_CATEGORY[request.category] : null;

  const data: Record<string, string> = {
    eventId: request.eventId,
    notificationId: request.notificationId,
    category: request.category,
    severity: request.severity,
  };
  if (request.accountId !== null) data['accountId'] = request.accountId;
  if (sound !== null) data['sound'] = sound;

  const critical = request.severity === 'CRITICAL';

  const message: FcmMessage = {
    token: request.token,
    notification: { title: request.title, body: request.body },
    data,
    ...(request.platform === DevicePlatform.ANDROID
      ? {
          android: {
            // A margin call delivered "when convenient" is a margin call the
            // trader reads after liquidation. Everything here is time-critical
            // by nature, so HIGH is the floor rather than the exception.
            priority: 'HIGH' as const,
            notification: {
              /**
               * The channel decides the sound from Android 8 on, and the two
               * fields beside it only before. Both are set, so a phone on
               * either side of that line hears the same thing — see
               * `ANDROID_CHANNEL_FOR_CATEGORY`.
               */
              channel_id: androidChannelFor(request.category, request.playSound),
              ...(sound === null ? { default_sound: false } : { sound: androidSound(sound) }),
              notification_priority: critical
                ? ('PRIORITY_HIGH' as const)
                : ('PRIORITY_DEFAULT' as const),
            },
          },
        }
      : {}),
    ...(request.platform === DevicePlatform.IOS
      ? {
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert',
            },
            payload: {
              aps: {
                ...(sound === null ? {} : { sound: appleSound(sound) }),
                /**
                 * `time-sensitive` asks iOS to break through Focus modes.
                 * Reserved for the notices a person cannot afford to miss —
                 * asking for it on every trade fill is how an app loses the
                 * permission altogether.
                 */
                'interruption-level': critical ? ('time-sensitive' as const) : ('active' as const),
              },
            },
          },
        }
      : {}),
    ...(request.platform === DevicePlatform.WEB
      ? { webpush: { headers: { Urgency: critical ? 'high' : 'normal' } } }
      : {}),
  };

  return message;
}

/** Android resolves a sound by resource name, without an extension. */
export function androidSound(sound: TradingSound): string {
  return sound;
}

/**
 * iOS resolves a sound by file name, extension included: "specify only the
 * filename of the sound file … If the system does not find a suitable sound
 * file, it plays the default sound." No error, no log.
 *
 * So the name is the name of the file the app bundles, and the app bundles
 * `.wav` (`apps/mobile/app.json`) — an extension iOS accepts for notification
 * sounds alongside `.aiff` and `.caf`. This said `.caf`, on the grounds that
 * Core Audio Format is what Apple suggests; no `.caf` file has ever been in the
 * app, so every iOS notice would have played the default sound.
 * `apps/mobile/src/lib/bundled-sounds.test.ts` holds this to the bundle.
 */
export function appleSound(sound: TradingSound): string {
  return `${sound}.wav`;
}

/**
 * Is this message small enough for FCM to accept?
 *
 * Checked before sending rather than after being refused, because the refusal
 * is an `INVALID_ARGUMENT` whose message does not say which field was too long,
 * and the usual cause is a notification body built from user-supplied text.
 */
export function withinPayloadLimit(message: FcmMessage): boolean {
  return Buffer.byteLength(JSON.stringify({ message }), 'utf8') <= FCM_MAX_PAYLOAD_BYTES;
}

/**
 * Shortens a body until the message fits.
 *
 * Truncating the body is the right thing to lose: the title carries what
 * happened and the payload carries the ids the client needs to fetch the rest.
 * Returns the message unchanged when it already fits.
 */
export function fitToPayloadLimit(message: FcmMessage): FcmMessage {
  if (withinPayloadLimit(message)) return message;

  let body = message.notification.body;
  let candidate = message;
  while (body.length > 16 && !withinPayloadLimit(candidate)) {
    body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
    candidate = { ...message, notification: { ...message.notification, body } };
  }
  return candidate;
}
