import type { DevicePlatform } from '@tp/shared-types';
import type { PushOutcome } from '@tp/push-core';

/**
 * One notification, addressed to one device.
 *
 * Deliberately not "one notification to a user's devices": a token can die
 * between two devices of the same person, and the outcome has to be recorded
 * per device or the admin view cannot answer *which* phone stopped receiving.
 */
export interface PushEnvelope {
  readonly deviceId: string;
  readonly platform: DevicePlatform;
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly notificationId: string;
  readonly eventId: string;
  readonly accountId: string | null;
  readonly playSound: boolean;
}

export interface PushResult {
  readonly deviceId: string;
  readonly outcome: PushOutcome;
  /** The provider's code, verbatim, when it gave one. */
  readonly errorCode: string | null;
  readonly providerMessageId: string | null;
}

/**
 * A push transport.
 *
 * An interface rather than a direct FCM call, for the same reason the market
 * feed has one: the thing behind it is a commercial dependency this platform
 * does not control, and the business logic must not be written against one
 * vendor's JSON. Adding APNs directly, or a Chinese vendor for an Android build
 * without Google Play, means one more implementation here and nothing else.
 */
export abstract class PushProvider {
  abstract readonly name: string;
  /** Sends one envelope. Must never throw: a transport failure is a result. */
  abstract send(envelope: PushEnvelope): Promise<PushResult>;
}
