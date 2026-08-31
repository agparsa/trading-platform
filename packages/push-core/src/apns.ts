import { NotificationCategory, SOUND_FOR_CATEGORY } from '@tp/shared-types';
import { PushOutcome } from './errors';
import { appleSound } from './message';
import type { PushRequest } from './message';

/**
 * The APNs notification payload.
 *
 * Apple's own shape, written out rather than taken from a library so the four
 * kilobytes this platform sends are reviewable in one place.
 *
 * Reference: developer.apple.com/documentation/usernotifications
 */
export interface ApnsPayload {
  readonly aps: {
    readonly alert: { readonly title: string; readonly body: string };
    readonly sound?: string;
    readonly 'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical';
    /** Groups repeat notices about one position into a single item. */
    readonly 'thread-id'?: string;
  };
  /** Custom keys sit beside `aps`, never inside it. */
  readonly [key: string]: unknown;
}

/** APNs rejects a payload above this. Smaller than FCM's, which is why it is checked separately. */
export const APNS_MAX_PAYLOAD_BYTES = 4096;

export interface ApnsHeaders {
  readonly 'apns-topic': string;
  readonly 'apns-push-type': 'alert';
  readonly 'apns-priority': '10' | '5';
  readonly 'apns-id': string;
  /**
   * `0` means "try once and do not store".
   *
   * Deliberately not used. A trader whose phone was in a tunnel when their stop
   * loss fired should still learn about it when they surface, so the notice is
   * given a real expiry rather than being discarded on first failure.
   */
  readonly 'apns-expiration': string;
  readonly 'apns-collapse-id'?: string;
}

export function buildApnsPayload(request: PushRequest): ApnsPayload {
  const sound = request.playSound ? SOUND_FOR_CATEGORY[request.category] : null;
  const critical = request.severity === 'CRITICAL';

  const payload: Record<string, unknown> = {
    aps: {
      alert: { title: request.title, body: request.body },
      ...(sound === null ? {} : { sound: appleSound(sound) }),
      /**
       * `time-sensitive` asks iOS to break through Focus modes. Reserved for
       * what a person cannot afford to miss — requesting it on every fill is
       * how an app loses the permission for the notices that need it.
       */
      'interruption-level': critical ? 'time-sensitive' : 'active',
      ...(request.accountId === null ? {} : { 'thread-id': request.accountId }),
    },
    // Beside `aps`, not inside it: iOS ignores unknown keys within `aps` and
    // the client would receive no event id at all.
    eventId: request.eventId,
    notificationId: request.notificationId,
    category: request.category,
    severity: request.severity,
    ...(request.accountId === null ? {} : { accountId: request.accountId }),
    ...(sound === null ? {} : { sound }),
  };

  return payload as ApnsPayload;
}

export function apnsHeaders(options: {
  topic: string;
  apnsId: string;
  expiresAtEpochSeconds: number;
}): ApnsHeaders {
  return {
    'apns-topic': options.topic,
    'apns-push-type': 'alert',
    // Everything this platform sends is time-critical by nature. A fill
    // delivered "based on power considerations" is a fill read an hour late.
    'apns-priority': '10',
    'apns-id': options.apnsId,
    'apns-expiration': String(options.expiresAtEpochSeconds),
  };
}

export function withinApnsPayloadLimit(payload: ApnsPayload): boolean {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= APNS_MAX_PAYLOAD_BYTES;
}

/**
 * Shortens the body until the payload fits.
 *
 * `PayloadTooLarge` is a permanent failure Apple explicitly says not to retry,
 * so it must be avoided rather than handled. The body is the right thing to
 * lose: the title says what happened and the custom keys carry the ids the app
 * needs to fetch the rest.
 */
export function fitApnsPayload(payload: ApnsPayload): ApnsPayload {
  if (withinApnsPayloadLimit(payload)) return payload;

  let body = payload.aps.alert.body;
  let candidate = payload;
  while (body.length > 16 && !withinApnsPayloadLimit(candidate)) {
    body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
    candidate = {
      ...payload,
      aps: { ...payload.aps, alert: { ...payload.aps.alert, body } },
    } as ApnsPayload;
  }
  return candidate;
}

/**
 * Reason strings that mean the token is dead.
 *
 * Apple's own list of what not to retry, filtered to the cases that are about
 * the *token* rather than about our request. `BadDeviceToken` is here — Apple
 * says never to retry it — but note that it also fires when a sandbox token is
 * sent to production, which is a configuration mistake rather than a dead
 * device. That case is called out in `classifyApns` because getting it wrong
 * deletes every token in a misconfigured deployment.
 */
const DEAD_TOKEN = new Set(['Unregistered', 'ExpiredToken', 'DeviceTokenNotForTopic']);

const RETRYABLE = new Set([
  'InternalServerError',
  'ServiceUnavailable',
  'Shutdown',
  'TooManyRequests',
  'IdleTimeout',
  // The provider token aged past an hour. Regenerating and retrying is exactly
  // what Apple asks for, and it is not the device's fault.
  'ExpiredProviderToken',
  'TooManyProviderTokenUpdates',
]);

export interface ApnsClassification {
  readonly outcome: PushOutcome;
  /**
   * True when the failure is almost certainly configuration rather than the
   * device — a wrong topic, the wrong environment, a bad signing key. The
   * caller logs these loudly because no amount of retrying fixes them.
   */
  readonly operatorMustLook: boolean;
}

export function classifyApns(status: number, reason: string | null): ApnsClassification {
  if (status === 200) return { outcome: PushOutcome.SENT, operatorMustLook: false };

  if (reason !== null && DEAD_TOKEN.has(reason)) {
    return { outcome: PushOutcome.DROP_TOKEN, operatorMustLook: false };
  }
  if (reason !== null && RETRYABLE.has(reason)) {
    return { outcome: PushOutcome.RETRY, operatorMustLook: reason === 'ExpiredProviderToken' };
  }

  /**
   * `BadDeviceToken` is the dangerous one.
   *
   * Apple returns it both for a genuinely malformed token and for a
   * development-environment token sent to the production host. The second is a
   * deployment mistake that affects *every* device at once, and treating it as
   * a dead token would silently unsubscribe the entire estate in a few minutes.
   *
   * So it does not drop the token. It stops the retry loop and shouts, which
   * leaves a human to decide — and the delivery record keeps the reason.
   */
  if (reason === 'BadDeviceToken') {
    return { outcome: PushOutcome.PERMANENT, operatorMustLook: true };
  }

  if (
    reason !== null &&
    [
      'BadTopic',
      'TopicDisallowed',
      'InvalidProviderToken',
      'MissingProviderToken',
      'Forbidden',
      'BadCertificate',
      'BadCertificateEnvironment',
      'UnrelatedKeyIdInToken',
      'BadEnvironmentKeyIdInToken',
    ].includes(reason)
  ) {
    return { outcome: PushOutcome.PERMANENT, operatorMustLook: true };
  }

  // No recognised reason. Fall back to the status, which never guesses a token
  // dead: 410 is the only status Apple defines as meaning exactly that.
  if (status === 410) return { outcome: PushOutcome.DROP_TOKEN, operatorMustLook: false };
  if (status === 429 || status >= 500)
    return { outcome: PushOutcome.RETRY, operatorMustLook: false };
  return { outcome: PushOutcome.PERMANENT, operatorMustLook: true };
}

/** Categories whose notices are worth storing for a device that is offline. */
export function apnsExpirySeconds(category: NotificationCategory, now: Date): number {
  const minutes =
    category === NotificationCategory.RISK_ALERT || category === NotificationCategory.SECURITY_ALERT
      ? 60
      : 15;
  /**
   * A stale trade notification is worse than none.
   *
   * "BTC/USDT opened at 64,120" arriving three hours later, after the position
   * has already closed, is actively misleading. Risk and security notices get
   * longer because they stay true: an account that was on margin call an hour
   * ago is still something its owner needs to know about.
   */
  return Math.floor(now.getTime() / 1000) + minutes * 60;
}
