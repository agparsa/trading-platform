import { describe, expect, it } from 'vitest';
import { DevicePlatform, NotificationCategory } from '@tp/shared-types';
import {
  apnsExpirySeconds,
  buildApnsPayload,
  classifyApns,
  fitApnsPayload,
  withinApnsPayloadLimit,
} from './apns';
import { PushOutcome } from './errors';
import type { PushRequest } from './message';

const base: PushRequest = {
  token: 'abc',
  platform: DevicePlatform.IOS,
  title: 'Position opened',
  body: 'BTC/USDT BUY 0.10 at 64,120.50',
  category: NotificationCategory.TRADE_OPENED,
  severity: 'INFO',
  notificationId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  playSound: true,
};

describe('the APNs payload', () => {
  it('puts custom keys beside aps, not inside it', () => {
    const payload = buildApnsPayload(base);
    // iOS silently ignores unknown keys within `aps`, so an eventId placed
    // there would reach the device and be invisible to the app — the client
    // would then have no way to deduplicate against the socket frame.
    expect(payload['eventId']).toBe(base.eventId);
    expect((payload.aps as Record<string, unknown>)['eventId']).toBeUndefined();
  });

  it('names the sound with the extension iOS expects', () => {
    expect(buildApnsPayload(base).aps.sound).toBe('trade_opened.wav');
  });

  it('sends no sound when the user turned it off', () => {
    expect(buildApnsPayload({ ...base, playSound: false }).aps.sound).toBeUndefined();
  });

  it('reserves time-sensitive for a critical notice', () => {
    expect(buildApnsPayload(base).aps['interruption-level']).toBe('active');
    expect(buildApnsPayload({ ...base, severity: 'CRITICAL' }).aps['interruption-level']).toBe(
      'time-sensitive',
    );
  });

  it("groups a position's notices by account", () => {
    expect(buildApnsPayload(base).aps['thread-id']).toBe(base.accountId);
  });

  it('shortens a body rather than being refused', () => {
    // PayloadTooLarge is a permanent failure Apple says not to retry, so it has
    // to be avoided rather than handled.
    const huge = buildApnsPayload({ ...base, body: 'x'.repeat(9_000) });
    expect(withinApnsPayloadLimit(huge)).toBe(false);
    const fitted = fitApnsPayload(huge);
    expect(withinApnsPayloadLimit(fitted)).toBe(true);
    expect(fitted.aps.alert.title).toBe(base.title);
    expect(fitted['eventId']).toBe(base.eventId);
  });
});

describe('classifying an APNs failure', () => {
  const outcome = (status: number, reason: string | null) => classifyApns(status, reason).outcome;

  it('treats 200 as sent', () => {
    expect(outcome(200, null)).toBe(PushOutcome.SENT);
  });

  it('drops a token Apple says is unregistered', () => {
    expect(outcome(410, 'Unregistered')).toBe(PushOutcome.DROP_TOKEN);
    expect(outcome(410, 'ExpiredToken')).toBe(PushOutcome.DROP_TOKEN);
  });

  it('drops a token that belongs to another app', () => {
    expect(outcome(400, 'DeviceTokenNotForTopic')).toBe(PushOutcome.DROP_TOKEN);
  });

  it('does NOT drop a token on BadDeviceToken', () => {
    /**
     * The most consequential line in this file.
     *
     * Apple returns BadDeviceToken both for a malformed token and for a sandbox
     * token sent to production. The second is a deployment mistake that affects
     * every device at once — treating it as a dead token would unsubscribe the
     * whole estate within minutes of a bad deploy, and nothing would say why.
     */
    const result = classifyApns(400, 'BadDeviceToken');
    expect(result.outcome).toBe(PushOutcome.PERMANENT);
    expect(result.operatorMustLook).toBe(true);
  });

  it('retries an outage', () => {
    expect(outcome(500, 'InternalServerError')).toBe(PushOutcome.RETRY);
    expect(outcome(503, 'ServiceUnavailable')).toBe(PushOutcome.RETRY);
    expect(outcome(503, 'Shutdown')).toBe(PushOutcome.RETRY);
  });

  it('retries a rate limit rather than dropping the device', () => {
    expect(outcome(429, 'TooManyRequests')).toBe(PushOutcome.RETRY);
    expect(outcome(429, 'TooManyProviderTokenUpdates')).toBe(PushOutcome.RETRY);
  });

  it('retries a stale provider token and asks somebody to look', () => {
    const result = classifyApns(403, 'ExpiredProviderToken');
    expect(result.outcome).toBe(PushOutcome.RETRY);
    expect(result.operatorMustLook).toBe(true);
  });

  it('stops on a configuration error', () => {
    for (const reason of ['BadTopic', 'TopicDisallowed', 'InvalidProviderToken', 'Forbidden']) {
      const result = classifyApns(403, reason);
      expect(result.outcome, reason).toBe(PushOutcome.PERMANENT);
      expect(result.operatorMustLook, reason).toBe(true);
    }
  });

  it('never guesses a token dead from a 5xx', () => {
    for (const status of [500, 503]) {
      expect(outcome(status, null)).not.toBe(PushOutcome.DROP_TOKEN);
    }
  });

  it('falls back to the status when the reason is unknown', () => {
    expect(outcome(410, 'SomethingAppleAddedLastWeek')).toBe(PushOutcome.DROP_TOKEN);
    expect(outcome(503, 'SomethingAppleAddedLastWeek')).toBe(PushOutcome.RETRY);
  });
});

describe('how long APNs should hold a notice', () => {
  const now = new Date('2026-08-31T12:00:00Z');

  it('keeps a risk alert longer than a trade notice', () => {
    const risk = apnsExpirySeconds(NotificationCategory.RISK_ALERT, now);
    const trade = apnsExpirySeconds(NotificationCategory.TRADE_OPENED, now);
    // "BTC opened at 64,120" arriving three hours later, after the position has
    // closed, is actively misleading. "You were on margin call" stays true.
    expect(risk).toBeGreaterThan(trade);
  });

  it('never asks APNs to discard on first failure', () => {
    // apns-expiration 0 means try once and drop. A trader in a tunnel when
    // their stop loss fires should still learn about it when they surface.
    expect(apnsExpirySeconds(NotificationCategory.TRADE_OPENED, now)).toBeGreaterThan(
      Math.floor(now.getTime() / 1000),
    );
  });
});
