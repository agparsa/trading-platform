/**
 * What to do about an FCM failure.
 *
 * The distinction is the whole value of this file. Getting it wrong in one
 * direction retries forever against a token that will never work again; in the
 * other, it deletes a working token because Google had a bad minute — and a
 * deleted token means a trader stops receiving margin calls and nobody finds
 * out until it matters.
 *
 * Source: firebase.google.com/docs/cloud-messaging/error-codes
 */
export const PushOutcome = {
  /** Delivered to FCM. Not the same as delivered to the phone; nothing can promise that. */
  SENT: 'SENT',
  /** The token is dead. Stop using it. */
  DROP_TOKEN: 'DROP_TOKEN',
  /** Transient. Retry with backoff. */
  RETRY: 'RETRY',
  /** Our fault or our configuration's. Retrying sends the same broken request. */
  PERMANENT: 'PERMANENT',
  /**
   * No push provider is configured, so nothing was attempted.
   *
   * Distinct from every other outcome on purpose. Reporting this as `SENT`
   * would make the admin panel's delivery statistics read 100% on a deployment
   * that has never sent a push — a number an operator would believe and act on.
   */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;
export type PushOutcome = (typeof PushOutcome)[keyof typeof PushOutcome];

/**
 * The documented error body.
 *
 * `error.status` carries the canonical Google code; `error.details` may carry an
 * `FcmError` with a more specific `errorCode`. The specific one is checked
 * first because `INVALID_ARGUMENT` covers both "your message was malformed" and
 * "that token is not a token", and those need opposite responses.
 */
export interface FcmErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ '@type'?: string; errorCode?: string }>;
  };
}

const FCM_ERROR_DETAIL = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

export function classify(httpStatus: number, body: FcmErrorBody | null): PushOutcome {
  if (httpStatus >= 200 && httpStatus < 300) return PushOutcome.SENT;

  const detail = body?.error?.details?.find((entry) => entry['@type'] === FCM_ERROR_DETAIL);
  const code = detail?.errorCode ?? body?.error?.status ?? '';

  switch (code) {
    case 'UNREGISTERED':
      // The app was uninstalled, or the token expired, or APNs says the device
      // is gone. Documented as "delete the token" without qualification.
      return PushOutcome.DROP_TOKEN;
    case 'SENDER_ID_MISMATCH':
      // The token belongs to a different Firebase project. It will never work
      // for us, however many times we try.
      return PushOutcome.DROP_TOKEN;
    case 'QUOTA_EXCEEDED':
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return PushOutcome.RETRY;
    case 'THIRD_PARTY_AUTH_ERROR':
      // The APNs certificate or web credentials are wrong. An operator has to
      // fix it; retrying just repeats the question.
      return PushOutcome.PERMANENT;
    case 'INVALID_ARGUMENT':
      /**
       * Deliberately *not* DROP_TOKEN.
       *
       * The documentation says to delete the token only when the *format* is
       * invalid — the same code is returned for a message this platform built
       * wrongly, and treating that as a dead token would quietly unsubscribe a
       * user because of our own bug. `PERMANENT` stops the retry loop and
       * leaves the token alone; the log says which message failed.
       */
      return PushOutcome.PERMANENT;
    default:
      break;
  }

  // No recognised code. Fall back to the HTTP status, which is coarse but never
  // deletes a token on a guess.
  if (httpStatus === 429 || httpStatus >= 500) return PushOutcome.RETRY;
  if (httpStatus === 404) return PushOutcome.DROP_TOKEN;
  return PushOutcome.PERMANENT;
}

/**
 * How long to wait before the next attempt.
 *
 * Exponential with full jitter. The jitter matters more than the exponent here:
 * a market event pushes to every device at once, so a fixed backoff would
 * synchronise every retry into the same second and reproduce the overload that
 * caused the first failure.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}
