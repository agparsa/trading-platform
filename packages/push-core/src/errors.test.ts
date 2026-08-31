import { describe, expect, it } from 'vitest';
import { backoffMs, classify, PushOutcome, type FcmErrorBody } from './errors';

const fcmError = (errorCode: string): FcmErrorBody => ({
  error: {
    code: 400,
    message: 'whatever',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
  },
});

/**
 * Which failures kill a token and which do not.
 *
 * Both directions are expensive. Retrying a dead token forever burns quota and
 * eventually earns a rate limit; deleting a live one because Google had a bad
 * minute means a trader silently stops receiving margin calls, and nobody
 * discovers it until the one that mattered.
 */
describe('classifying an FCM failure', () => {
  it('treats success as sent', () => {
    expect(classify(200, null)).toBe(PushOutcome.SENT);
  });

  it('drops the token when the app is gone', () => {
    expect(classify(404, fcmError('UNREGISTERED'))).toBe(PushOutcome.DROP_TOKEN);
  });

  it('drops a token that belongs to another project', () => {
    expect(classify(403, fcmError('SENDER_ID_MISMATCH'))).toBe(PushOutcome.DROP_TOKEN);
  });

  it('retries a quota refusal rather than dropping the device', () => {
    expect(classify(429, fcmError('QUOTA_EXCEEDED'))).toBe(PushOutcome.RETRY);
  });

  it('retries an outage', () => {
    expect(classify(503, fcmError('UNAVAILABLE'))).toBe(PushOutcome.RETRY);
    expect(classify(500, fcmError('INTERNAL'))).toBe(PushOutcome.RETRY);
  });

  it('does not delete a token because our own message was malformed', () => {
    // INVALID_ARGUMENT covers both "that is not a token" and "your message was
    // wrong". Treating it as a dead token would unsubscribe a user because of
    // our bug, so it stops the retry loop without touching the device.
    expect(classify(400, fcmError('INVALID_ARGUMENT'))).toBe(PushOutcome.PERMANENT);
  });

  it('does not retry a credential problem', () => {
    expect(classify(401, fcmError('THIRD_PARTY_AUTH_ERROR'))).toBe(PushOutcome.PERMANENT);
  });

  it('prefers the specific FcmError code over the canonical status', () => {
    // The body says INVALID_ARGUMENT at the top level and UNREGISTERED in the
    // detail. Reading only `error.status` would retry a token that is dead.
    expect(classify(400, fcmError('UNREGISTERED'))).toBe(PushOutcome.DROP_TOKEN);
  });

  it('falls back to the HTTP status when there is no recognised code', () => {
    expect(classify(503, null)).toBe(PushOutcome.RETRY);
    expect(classify(429, {})).toBe(PushOutcome.RETRY);
    expect(classify(404, {})).toBe(PushOutcome.DROP_TOKEN);
    expect(classify(418, {})).toBe(PushOutcome.PERMANENT);
  });

  it('never guesses a token dead from a 5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classify(status, null)).not.toBe(PushOutcome.DROP_TOKEN);
    }
  });
});

describe('backoff', () => {
  it('grows with the attempt', () => {
    const noJitter = () => 1;
    expect(backoffMs(1, noJitter)).toBe(1_000);
    expect(backoffMs(2, noJitter)).toBe(2_000);
    expect(backoffMs(4, noJitter)).toBe(8_000);
  });

  it('is capped', () => {
    expect(backoffMs(30, () => 1)).toBe(60_000);
  });

  it('jitters, so a market-wide failure does not retry in lockstep', () => {
    // Full jitter: the wait is somewhere in [50%, 100%] of the base. Without it
    // every device retries in the same second and reproduces the overload.
    expect(backoffMs(4, () => 0)).toBe(4_000);
    expect(backoffMs(4, () => 1)).toBe(8_000);
  });

  it('never returns a negative or zero wait', () => {
    for (const attempt of [-5, 0, 1, 2, 10]) {
      expect(backoffMs(attempt, () => 0)).toBeGreaterThan(0);
    }
  });
});
