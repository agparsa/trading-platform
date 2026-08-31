import { Injectable, Logger } from '@nestjs/common';
import { PushOutcome } from '@tp/push-core';
import { PushProvider, type PushEnvelope, type PushResult } from './push.port';

/**
 * The provider used when no push credentials are configured.
 *
 * It records `SKIPPED`, not `SENT`.
 *
 * That distinction is the entire point of this class. A no-op that reported
 * success would make the admin panel's delivery statistics — the numbers an
 * operator uses to answer "are our notifications working" — read 100% on a
 * deployment that has never sent a single push. Reporting the truth means an
 * unconfigured deployment looks unconfigured.
 */
@Injectable()
export class NoopPushProvider extends PushProvider {
  readonly name = 'noop';
  private readonly logger = new Logger(NoopPushProvider.name);
  private warned = false;

  async send(envelope: PushEnvelope): Promise<PushResult> {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'No push provider is configured; push notifications are being recorded as skipped. ' +
          'Set PUSH_PROVIDER=fcm and FCM_SERVICE_ACCOUNT_JSON to enable delivery.',
      );
    }
    return {
      deviceId: envelope.deviceId,
      outcome: PushOutcome.NOT_CONFIGURED,
      errorCode: 'NO_PROVIDER',
      providerMessageId: null,
    };
  }
}
