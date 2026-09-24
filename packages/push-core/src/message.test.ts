import { describe, expect, it } from 'vitest';
import { DevicePlatform, NotificationCategory } from '@tp/shared-types';
import {
  buildFcmMessage,
  fitToPayloadLimit,
  withinPayloadLimit,
  type PushRequest,
} from './message';

const base: PushRequest = {
  token: 'device-token',
  platform: DevicePlatform.ANDROID,
  title: 'Position opened',
  body: 'BTC/USDT BUY 0.10 at 64,120.50',
  category: NotificationCategory.TRADE_OPENED,
  severity: 'INFO',
  notificationId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  playSound: true,
};

describe('building an FCM message', () => {
  it('carries the event id so a client can process it once', () => {
    // §26. The socket frame and the push both carry it; the client that has
    // already handled the frame must not play the sound a second time.
    const message = buildFcmMessage(base);
    expect(message.data['eventId']).toBe(base.eventId);
    expect(message.data['notificationId']).toBe(base.notificationId);
  });

  it('names the sound in every place a platform looks for it', () => {
    const android = buildFcmMessage(base);
    expect(android.data['sound']).toBe('trade_opened');
    expect(android.android?.notification.sound).toBe('trade_opened');

    const ios = buildFcmMessage({ ...base, platform: DevicePlatform.IOS });
    // iOS wants a file name with an extension; Android wants a resource name
    // without one. Getting this wrong is silent on exactly one platform.
    expect(ios.apns?.payload.aps.sound).toBe('trade_opened.caf');
    expect(ios.data['sound']).toBe('trade_opened');
  });

  it('gives a modification a different sound from an opening', () => {
    // §18 asks for this specifically, and it is the one sound rule a user will
    // notice immediately if it is wrong.
    const opened = buildFcmMessage(base);
    const modified = buildFcmMessage({
      ...base,
      category: NotificationCategory.TRADE_MODIFIED,
    });
    expect(modified.data['sound']).not.toBe(opened.data['sound']);
    expect(modified.data['sound']).toBe('trade_modified');
  });

  it('stays silent when the user turned the sound off', () => {
    const message = buildFcmMessage({ ...base, playSound: false });
    expect(message.data['sound']).toBeUndefined();
    expect(message.android?.notification.sound).toBeUndefined();
    expect(message.android?.notification.default_sound).toBe(false);
    // And on Android 8+, where the two fields above are not read: the channel.
    expect(message.android?.notification.channel_id).toBe('quiet');
  });

  it("posts each notice to its category's channel, which is its sound on Android 8+", () => {
    // Every push named `trading`, whose sound is an opening. A stop loss
    // sounded like a new trade on every current Android phone.
    expect(buildFcmMessage(base).android?.notification.channel_id).toBe('trading');
    expect(
      buildFcmMessage({ ...base, category: NotificationCategory.STOP_LOSS }).android?.notification
        .channel_id,
    ).toBe('trading-stop-loss');
    expect(
      buildFcmMessage({ ...base, category: NotificationCategory.RISK_ALERT }).android?.notification
        .channel_id,
    ).toBe('risk');
  });

  it('asks to break through Focus only for a critical notice', () => {
    const routine = buildFcmMessage({ ...base, platform: DevicePlatform.IOS });
    expect(routine.apns?.payload.aps['interruption-level']).toBe('active');

    const stopOut = buildFcmMessage({
      ...base,
      platform: DevicePlatform.IOS,
      severity: 'CRITICAL',
      category: NotificationCategory.RISK_ALERT,
    });
    // Asking for time-sensitive on every fill is how an app loses the
    // permission for the notices that need it.
    expect(stopOut.apns?.payload.aps['interruption-level']).toBe('time-sensitive');
  });

  it('sends only the block its own platform reads', () => {
    const android = buildFcmMessage(base);
    expect(android.android).toBeDefined();
    expect(android.apns).toBeUndefined();

    const web = buildFcmMessage({ ...base, platform: DevicePlatform.WEB });
    expect(web.webpush).toBeDefined();
    expect(web.android).toBeUndefined();
  });

  it('keeps every data value a string, as FCM requires', () => {
    const message = buildFcmMessage(base);
    for (const [key, value] of Object.entries(message.data)) {
      expect(typeof value, `data.${key}`).toBe('string');
    }
  });

  it('omits accountId rather than sending null', () => {
    // `data: { accountId: null }` is rejected by the API with a message that
    // does not name the field.
    const message = buildFcmMessage({ ...base, accountId: null });
    expect(message.data['accountId']).toBeUndefined();
  });

  it('shortens an oversized body instead of being refused', () => {
    const huge = buildFcmMessage({ ...base, body: 'x'.repeat(8_000) });
    expect(withinPayloadLimit(huge)).toBe(false);

    const fitted = fitToPayloadLimit(huge);
    expect(withinPayloadLimit(fitted)).toBe(true);
    // The title and the ids survive: they are what the client needs to fetch
    // the rest. The body is the right thing to lose.
    expect(fitted.notification.title).toBe(base.title);
    expect(fitted.data['eventId']).toBe(base.eventId);
  });

  it('leaves a message that already fits alone', () => {
    const message = buildFcmMessage(base);
    expect(fitToPayloadLimit(message)).toBe(message);
  });
});
