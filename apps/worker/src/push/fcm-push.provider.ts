import { Injectable, Logger } from '@nestjs/common';
import {
  PushOutcome,
  buildFcmMessage,
  classify,
  fitToPayloadLimit,
  type FcmErrorBody,
} from '@tp/push-core';
import type { NotificationCategory } from '@tp/shared-types';
import { GoogleAccessTokens, type ServiceAccount } from './google-auth';
import { PushProvider, type PushEnvelope, type PushResult } from './push.port';

export const FCM_SEND_ENDPOINT = (projectId: string): string =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * One device per request: v1 has no batch endpoint, and the `batch` endpoint
 * that used to exist was retired. Concurrency is the caller's business.
 *
 * ## Why iOS goes through here too
 *
 * FCM forwards to APNs on Apple's behalf when the `apns` block is present, so
 * one credential and one code path cover both platforms. Talking to APNs
 * directly would mean a second provider, a second key format, and a second set
 * of error semantics for no gain this platform can currently name.
 */
@Injectable()
export class FcmPushProvider extends PushProvider {
  readonly name = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly tokens: GoogleAccessTokens;
  private readonly endpoint: string;

  constructor(
    account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.tokens = new GoogleAccessTokens(account, fetchImpl);
    this.endpoint = FCM_SEND_ENDPOINT(account.projectId);
  }

  /**
   * Never throws.
   *
   * Every failure mode — a dead token, an outage, a broken credential, the
   * network being gone — comes back as a `PushResult` the caller records. A
   * throw here would fail the notification job, and the notification row has
   * already been written: retrying the job would attempt the push again against
   * the devices that already received it.
   */
  async send(envelope: PushEnvelope): Promise<PushResult> {
    let accessToken: string;
    try {
      accessToken = await this.tokens.get();
    } catch (error) {
      this.logger.error({ err: error }, 'Could not obtain an FCM access token');
      return result(envelope, PushOutcome.RETRY, 'AUTH_UNAVAILABLE');
    }

    const message = fitToPayloadLimit(
      buildFcmMessage({
        token: envelope.token,
        platform: envelope.platform,
        title: envelope.title,
        body: envelope.body,
        category: envelope.category as NotificationCategory,
        severity: envelope.severity,
        notificationId: envelope.notificationId,
        eventId: envelope.eventId,
        accountId: envelope.accountId,
        playSound: envelope.playSound,
      }),
    );

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message }),
      });
    } catch (error) {
      // A network failure is transient by assumption. Assuming otherwise would
      // let a brief outage delete every token in the estate.
      this.logger.warn({ err: error, deviceId: envelope.deviceId }, 'FCM send failed to connect');
      return result(envelope, PushOutcome.RETRY, 'NETWORK');
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
      return {
        deviceId: envelope.deviceId,
        outcome: PushOutcome.SENT,
        errorCode: null,
        providerMessageId: typeof body?.name === 'string' ? body.name : null,
      };
    }

    const body = (await response.json().catch(() => null)) as FcmErrorBody | null;
    const outcome = classify(response.status, body);
    const code =
      body?.error?.details?.find(
        (entry) => entry['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
      )?.errorCode ??
      body?.error?.status ??
      `HTTP_${response.status}`;

    if (outcome === PushOutcome.PERMANENT) {
      // Worth shouting about: this is nearly always our message or our
      // credentials, and it will keep happening until somebody looks.
      this.logger.error(
        { deviceId: envelope.deviceId, status: response.status, code },
        'FCM refused a message permanently',
      );
    }

    return result(envelope, outcome, code);
  }
}

function result(envelope: PushEnvelope, outcome: PushOutcome, errorCode: string): PushResult {
  return { deviceId: envelope.deviceId, outcome, errorCode, providerMessageId: null };
}
