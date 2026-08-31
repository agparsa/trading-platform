import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, parseEncryptionKeys } from '@tp/crypto-core';
import type { WorkerEnv } from '../env';
import { PrismaService } from '../prisma.service';
import { FcmPushProvider } from './fcm-push.provider';
import { NoopPushProvider } from './noop-push.provider';
import { parseServiceAccount } from './google-auth';
import { PushProvider } from './push.port';
import { PushService } from './push.service';

/**
 * Chooses the push transport from configuration, once, at boot.
 *
 * The same shape as the market feed's provider selection, and for the same
 * reason: an unimplemented provider must fail loudly at startup rather than on
 * the first message. `env.ts` has already refused to boot without the
 * credentials `fcm` needs, so by the time this factory runs the only remaining
 * failure is a malformed service-account blob — which `parseServiceAccount`
 * reports with the missing field named.
 */
@Module({
  providers: [
    PrismaService,
    {
      provide: SecretBox,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) => {
        const keys = config.get('SECRET_ENCRYPTION_KEYS', { infer: true });
        // A throwaway key when none is configured: the no-op provider never
        // opens a token, and constructing SecretBox with an empty list throws.
        return new SecretBox(
          parseEncryptionKeys(keys ?? 'unconfigured:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
        );
      },
    },
    {
      provide: PushProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>): PushProvider => {
        const kind = config.get('PUSH_PROVIDER', { infer: true });
        if (kind !== 'fcm') return new NoopPushProvider();

        const raw = config.get('FCM_SERVICE_ACCOUNT_JSON', { infer: true });
        if (raw === undefined) {
          // env.ts should have caught this. Repeated because a provider that
          // silently degrades to no-op would make a configured deployment stop
          // sending without saying so.
          throw new Error('PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT_JSON is not set');
        }
        return new FcmPushProvider(
          parseServiceAccount(raw),
          config.get('PUSH_ANDROID_CHANNEL_ID', { infer: true }),
        );
      },
    },
    PushService,
  ],
  exports: [PushService, PushProvider],
})
export class PushModule {}
