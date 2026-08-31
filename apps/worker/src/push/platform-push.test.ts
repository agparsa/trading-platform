import { describe, expect, it } from 'vitest';
import { PushOutcome } from '@tp/push-core';
import { DevicePlatform } from '@tp/shared-types';
import { PlatformPushProvider } from './platform-push.provider';
import { PushProvider, type PushEnvelope, type PushResult } from './push.port';

class Marker extends PushProvider {
  constructor(readonly name: string) {
    super();
  }
  readonly seen: PushEnvelope[] = [];
  async send(envelope: PushEnvelope): Promise<PushResult> {
    this.seen.push(envelope);
    return {
      deviceId: envelope.deviceId,
      outcome: PushOutcome.SENT,
      errorCode: null,
      providerMessageId: this.name,
    };
  }
}

const envelope = (platform: DevicePlatform): PushEnvelope => ({
  deviceId: 'device-1',
  platform,
  token: 'token',
  title: 'Position opened',
  body: 'BTC/USDT BUY 0.10',
  category: 'TRADE_OPENED',
  severity: 'INFO',
  notificationId: 'n-1',
  eventId: 'e-1',
  accountId: 'a-1',
  playSound: true,
});

/**
 * Each device to the service that can actually reach it.
 *
 * The client holds a different kind of token per platform: an FCM registration
 * token on Android, a raw APNs token on iOS. Sending the second to FCM fails
 * with INVALID_ARGUMENT, which the FCM classifier treats as *our* bug rather
 * than a dead token — so it would retry forever while no iPhone ever rang.
 */
describe('routing a push by platform', () => {
  it('sends an iPhone to APNs and an Android to FCM', async () => {
    const apns = new Marker('apns');
    const fcm = new Marker('fcm');
    const router = new PlatformPushProvider({ ios: apns, android: fcm, web: fcm });

    await router.send(envelope(DevicePlatform.IOS));
    await router.send(envelope(DevicePlatform.ANDROID));

    expect(apns.seen).toHaveLength(1);
    expect(fcm.seen).toHaveLength(1);
  });

  it('sends a browser through FCM', async () => {
    const fcm = new Marker('fcm');
    const router = new PlatformPushProvider({ ios: null, android: fcm, web: fcm });
    const result = await router.send(envelope(DevicePlatform.WEB));
    expect(result.providerMessageId).toBe('fcm');
  });

  it('records an unconfigured platform as skipped, never as sent', async () => {
    const fcm = new Marker('fcm');
    const router = new PlatformPushProvider({ ios: null, android: fcm, web: fcm });

    const result = await router.send(envelope(DevicePlatform.IOS));

    // An operator who set up Android and not iOS should see exactly that in the
    // admin figures — not a hundred per cent success including phones nothing
    // was ever sent to.
    expect(result.outcome).toBe(PushOutcome.NOT_CONFIGURED);
    expect(result.errorCode).toBe('NO_PROVIDER_FOR_IOS');
    expect(fcm.seen).toHaveLength(0);
  });

  it('never sends an iOS token to the Android provider', async () => {
    const fcm = new Marker('fcm');
    const router = new PlatformPushProvider({ ios: null, android: fcm, web: fcm });
    await router.send(envelope(DevicePlatform.IOS));
    // The whole point of the router: a raw APNs token handed to FCM would fail
    // in a way that looks like our bug and retries indefinitely.
    expect(fcm.seen).toEqual([]);
  });
});
