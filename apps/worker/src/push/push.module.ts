import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, parseEncryptionKeys } from '@tp/crypto-core';
import type { WorkerEnv } from '../env';
import { PrismaService } from '../prisma.service';
import { ApnsPushProvider } from './apns-push.provider';
import { parseApnsCredentials } from './apns-auth';
import { FcmPushProvider } from './fcm-push.provider';
import { NoopPushProvider } from './noop-push.provider';
import { PlatformPushProvider } from './platform-push.provider';
import { parseServiceAccount } from './google-auth';
import { PushProvider } from './push.port';
import { PushService } from './push.service';

/**
 * Assembles the push transports from configuration, once, at boot.
 *
 * A platform is served if — and only if — its credentials are present. There is
 * no per-platform on/off switch to get out of step with the credentials
 * themselves: an operator who has set up Android and not iOS sees Android
 * delivered and iOS recorded as skipped, which is the truth without anyone
 * having to declare it twice.
 *
 * The same shape as the market feed's provider selection, and for the same
 * reason: a misconfiguration must fail at startup rather than on the first
 * message that needed to reach somebody.
 */
@Module({
  providers: [
    PrismaService,
    {
      provide: SecretBox,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) => {
        const keys = config.get('SECRET_ENCRYPTION_KEYS', { infer: true });
        // A throwaway key when none is configured: with push off no token is
        // ever opened, and constructing SecretBox with an empty list throws.
        return new SecretBox(
          parseEncryptionKeys(keys ?? 'unconfigured:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
        );
      },
    },
    {
      provide: PushProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>): PushProvider => {
        if (!config.get('PUSH_ENABLED', { infer: true })) return new NoopPushProvider();

        const serviceAccount = config.get('FCM_SERVICE_ACCOUNT_JSON', { infer: true });
        const apns = config.get('APNS_CREDENTIALS_JSON', { infer: true });

        const fcm =
          serviceAccount === undefined
            ? null
            : new FcmPushProvider(parseServiceAccount(serviceAccount));

        return new PlatformPushProvider({
          ios: apns === undefined ? null : new ApnsPushProvider(parseApnsCredentials(apns)),
          android: fcm,
          // Web push also travels through FCM, which speaks the Web Push
          // protocol on our behalf given a VAPID key in the Firebase project.
          web: fcm,
        });
      },
    },
    PushService,
  ],
  exports: [PushService, PushProvider],
})
export class PushModule {}
