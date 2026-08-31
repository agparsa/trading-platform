import { randomUUID } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { Injectable, Logger } from '@nestjs/common';
import {
  PushOutcome,
  apnsExpirySeconds,
  apnsHeaders,
  buildApnsPayload,
  classifyApns,
  fitApnsPayload,
} from '@tp/push-core';
import type { NotificationCategory } from '@tp/shared-types';
import { ApnsTokens, apnsHost, type ApnsCredentials } from './apns-auth';
import { PushProvider, type PushEnvelope, type PushResult } from './push.port';

const { HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS, HTTP2_HEADER_AUTHORIZATION } =
  constants;

/**
 * Apple Push Notification service, over HTTP/2.
 *
 * ## Why not through FCM
 *
 * Because of what the client actually holds. Expo's documented path for a
 * self-hosted server gives `getDevicePushTokenAsync()` — an **FCM registration
 * token on Android and a raw APNs token on iOS**. FCM cannot send to a raw APNs
 * token, so routing iPhones through the FCM adapter would fail every send with
 * `INVALID_ARGUMENT`, which the classifier deliberately does not treat as a
 * dead token — so it would retry forever and nobody's iPhone would ever ring.
 *
 * The alternative was adding the Firebase iOS SDK to the app so it returns an
 * FCM token instead. That trades this file for a native dependency, a config
 * plugin, and a known-awkward interaction with `expo-notifications`' own
 * delegate handling. Talking to Apple directly is the path Apple and Expo both
 * document.
 *
 * ## The connection is reused
 *
 * Apple asks for it explicitly — a session can live for hours — and a new TLS
 * handshake per notification would put a round trip in front of every margin
 * call.
 */
@Injectable()
export class ApnsPushProvider extends PushProvider {
  readonly name = 'apns';
  private readonly logger = new Logger(ApnsPushProvider.name);
  private readonly tokens: ApnsTokens;
  private session: ClientHttp2Session | null = null;

  constructor(private readonly credentials: ApnsCredentials) {
    super();
    this.tokens = new ApnsTokens(credentials);
  }

  async send(envelope: PushEnvelope): Promise<PushResult> {
    const now = new Date();
    const request = {
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
      androidChannelId: '',
    };

    const payload = fitApnsPayload(buildApnsPayload(request));
    const apnsId = randomUUID();
    const headers = apnsHeaders({
      topic: this.credentials.bundleId,
      apnsId,
      expiresAtEpochSeconds: apnsExpirySeconds(request.category, now),
    });

    let response: { status: number; reason: string | null };
    try {
      response = await this.post(envelope.token, { ...headers }, payload);
    } catch (error) {
      // A transport failure is transient by assumption. Assuming otherwise
      // would let one bad minute unsubscribe the estate.
      this.logger.warn({ err: error, deviceId: envelope.deviceId }, 'APNs send failed to connect');
      return {
        deviceId: envelope.deviceId,
        outcome: PushOutcome.RETRY,
        errorCode: 'NETWORK',
        providerMessageId: null,
      };
    }

    const { outcome, operatorMustLook } = classifyApns(response.status, response.reason);

    if (response.reason === 'ExpiredProviderToken') {
      // Apple asks for a fresh token rather than a retry of the same one.
      this.tokens.invalidate();
    }
    if (operatorMustLook) {
      this.logger.error(
        { deviceId: envelope.deviceId, status: response.status, reason: response.reason },
        'APNs refused a notification for a reason no retry will fix',
      );
    }

    return {
      deviceId: envelope.deviceId,
      outcome,
      errorCode:
        response.reason ?? (outcome === PushOutcome.SENT ? null : `HTTP_${response.status}`),
      providerMessageId: outcome === PushOutcome.SENT ? apnsId : null,
    };
  }

  /** Opens the session lazily and reuses it, as Apple asks. */
  private connection(): ClientHttp2Session {
    if (this.session !== null && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = connect(apnsHost(this.credentials));
    session.on('error', (error) => {
      this.logger.warn({ err: error }, 'APNs session error; it will be reopened');
      this.session = null;
    });
    // A GOAWAY is Apple asking us to reconnect, not an incident.
    session.on('goaway', () => {
      this.session = null;
    });
    this.session = session;
    return session;
  }

  private post(
    deviceToken: string,
    headers: Record<string, string | undefined>,
    payload: unknown,
  ): Promise<{ status: number; reason: string | null }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const stream = this.connection().request({
        [HTTP2_HEADER_METHOD]: 'POST',
        [HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        [HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.tokens.get()}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      });

      let status = 0;
      const chunks: Buffer[] = [];

      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => {
        // A successful push has an empty body; only a failure carries JSON.
        if (chunks.length === 0) {
          resolve({ status, reason: null });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            reason?: unknown;
          };
          resolve({
            status,
            reason: typeof parsed.reason === 'string' ? parsed.reason : null,
          });
        } catch {
          resolve({ status, reason: null });
        }
      });

      stream.setTimeout(15_000, () => {
        stream.close();
        reject(new Error('APNs did not answer within 15 seconds'));
      });

      stream.end(body);
    });
  }

  /** Closes the shared session. Called on worker shutdown. */
  close(): void {
    this.session?.close();
    this.session = null;
  }
}
