import { Injectable, Logger } from '@nestjs/common';
import { PushOutcome } from '@tp/push-core';
import { DevicePlatform } from '@tp/shared-types';
import { PushProvider, type PushEnvelope, type PushResult } from './push.port';

/**
 * Sends each device to the service that can actually reach it.
 *
 * The reason this exists rather than one provider: the client holds a different
 * kind of token per platform. `getDevicePushTokenAsync()` returns an **FCM
 * registration token on Android** and a **raw APNs token on iOS**, and neither
 * service accepts the other's. Sending an APNs token to FCM fails with
 * `INVALID_ARGUMENT` — which the FCM classifier deliberately treats as *our
 * bug*, not a dead token, so it would retry forever and no iPhone would ever
 * ring while the delivery statistics quietly filled with failures.
 *
 * A platform with no provider configured is `NOT_CONFIGURED`, never `SENT`. An
 * operator who has set up Android and not iOS should see exactly that in the
 * admin figures.
 */
@Injectable()
export class PlatformPushProvider extends PushProvider {
  readonly name = 'platform';
  private readonly logger = new Logger(PlatformPushProvider.name);

  constructor(
    private readonly providers: {
      readonly ios: PushProvider | null;
      readonly android: PushProvider | null;
      readonly web: PushProvider | null;
    },
  ) {
    super();
  }

  async send(envelope: PushEnvelope): Promise<PushResult> {
    const provider = this.providerFor(envelope.platform);
    if (provider === null) {
      this.warnOnce(envelope.platform);
      return {
        deviceId: envelope.deviceId,
        outcome: PushOutcome.NOT_CONFIGURED,
        errorCode: `NO_PROVIDER_FOR_${envelope.platform}`,
        providerMessageId: null,
      };
    }
    return provider.send(envelope);
  }

  private providerFor(platform: string): PushProvider | null {
    switch (platform) {
      case DevicePlatform.IOS:
        return this.providers.ios;
      case DevicePlatform.ANDROID:
        return this.providers.android;
      case DevicePlatform.WEB:
        return this.providers.web;
      default:
        return null;
    }
  }

  private readonly warned = new Set<string>();
  private warnOnce(platform: string): void {
    if (this.warned.has(platform)) return;
    this.warned.add(platform);
    this.logger.warn(
      `No push provider is configured for ${platform}; those notifications are recorded as skipped.`,
    );
  }
}
