import { Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  TradingErrorCode,
  type DeviceDto,
  type DevicePlatform,
} from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../common/crypto/crypto.module';

/**
 * The phones, tablets and browsers a person has signed in from.
 *
 * ## What this is for
 *
 * Two things that look separate and are not. It is the list a trader reads to
 * answer "what has access to my account", and it is the address book the push
 * fan-out reads to answer "where does this notice go". Keeping them one table
 * means revoking a device in the first sense also stops notifications in the
 * second — which is what a person revoking a lost phone actually means.
 *
 * ## Why the token never leaves
 *
 * A push token is a bearer credential for delivering messages to a device.
 * Anyone holding one can send a notification that arrives looking like it came
 * from the trading platform, to somebody who is already expecting messages
 * about their money. So it is sealed at rest and `toDto` has no branch that
 * could return it — the plaintext is reachable only from `pushTargets`, which
 * no controller calls.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
  ) {}

  /**
   * Register this installation, or update what we already knew about it.
   *
   * Keyed on `installationId`, never on the token. FCM and APNs rotate tokens
   * without being asked; keyed on the token, every rotation would create a
   * second row and the trader would receive every notification twice. This is
   * the whole of the duplicate-device problem, and solving it here is why the
   * delivery path does not need to deduplicate by device.
   */
  async register(
    userId: string,
    input: {
      platform: DevicePlatform;
      installationId: string;
      pushToken?: string | null;
      appVersion?: string | null;
      osVersion?: string | null;
      model?: string | null;
      locale?: string | null;
    },
  ): Promise<DeviceDto> {
    const tenantId = requireTenantId();
    const sealed =
      input.pushToken === undefined || input.pushToken === null || input.pushToken.length === 0
        ? null
        : this.secrets.seal(input.pushToken, sealContext(userId, input.installationId));
    const fingerprint =
      input.pushToken === undefined || input.pushToken === null
        ? null
        : fingerprintOf(input.pushToken);

    const now = new Date();
    const row = await this.prisma.device.upsert({
      where: {
        tenantId_userId_installationId: {
          tenantId,
          userId,
          installationId: input.installationId,
        },
      },
      create: {
        tenantId,
        userId,
        platform: input.platform,
        installationId: input.installationId,
        pushToken: sealed,
        pushTokenFingerprint: fingerprint,
        appVersion: input.appVersion ?? null,
        osVersion: input.osVersion ?? null,
        model: input.model ?? null,
        locale: input.locale ?? null,
        lastSeenAt: now,
      },
      update: {
        platform: input.platform,
        // A re-register with no token must not wipe a working one: the app
        // calls this on every launch, and notification permission is granted
        // once, later. Only an explicitly supplied token replaces what is there.
        ...(sealed === null
          ? {}
          : { pushToken: sealed, pushTokenFingerprint: fingerprint, pushTokenRejectedAt: null }),
        ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
        ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        // Re-registering revives a device the user had deactivated only because
        // they have signed in on it again, which is consent expressed by action.
        isActive: true,
        lastSeenAt: now,
      },
    });

    return toDto(row);
  }

  /** The caller's own devices, newest activity first. */
  async list(userId: string): Promise<DeviceDto[]> {
    const rows = await this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map(toDto);
  }

  /**
   * Stop sending to a device.
   *
   * The token is cleared, not just the flag. A deactivated row that still holds
   * a live token is one bug away from waking a phone its owner has revoked, and
   * the row is worth keeping for the audit trail without it.
   */
  async deactivate(userId: string, deviceId: string): Promise<{ id: string }> {
    const result = await this.prisma.device.updateMany({
      where: { id: deviceId, userId },
      data: {
        isActive: false,
        pushToken: null,
        pushTokenFingerprint: null,
      },
    });
    if (result.count === 0) {
      // Scoped by userId in the same statement, so somebody else's device id is
      // "not found" rather than "found and refused". The two are
      // indistinguishable to the caller, which is the point.
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such device');
    }
    return { id: deviceId };
  }

  /**
   * Where a notification for this person should go.
   *
   * Internal. Returns plaintext tokens and is therefore never reachable from a
   * controller — the only caller is the push fan-out. A device whose token the
   * provider has rejected is excluded: sending to it again earns a rate-limit
   * penalty from the provider and reaches nobody.
   */
  async pushTargets(userId: string): Promise<PushTarget[]> {
    const rows = await this.prisma.device.findMany({
      where: {
        userId,
        isActive: true,
        pushToken: { not: null },
        pushTokenRejectedAt: null,
      },
      select: {
        id: true,
        platform: true,
        installationId: true,
        pushToken: true,
        locale: true,
      },
    });

    const targets: PushTarget[] = [];
    for (const row of rows) {
      if (row.pushToken === null) continue;
      try {
        targets.push({
          deviceId: row.id,
          platform: row.platform,
          locale: row.locale,
          token: this.secrets.open(row.pushToken, sealContext(userId, row.installationId)),
        });
      } catch (error) {
        // A token sealed under a key that has since been retired cannot be
        // recovered, and there is nothing the delivery path can do about it.
        // Skipping is right; failing the whole fan-out because one device is
        // unreadable would silence every other device the person owns.
        this.logger.error({ err: error, deviceId: row.id }, 'Could not open a stored push token');
      }
    }
    return targets;
  }

  /**
   * The provider says this token is dead.
   *
   * Recorded rather than cleared. "This device stopped receiving on the 3rd,
   * because the provider said the app was uninstalled" is a supportable answer;
   * a row that quietly lost its token is not.
   */
  async markTokenRejected(deviceId: string): Promise<void> {
    await this.prisma.device.updateMany({
      where: { id: deviceId },
      data: { pushTokenRejectedAt: new Date() },
    });
  }

  /** Keeps `lastSeenAt` honest without a full re-register. */
  async touch(userId: string, installationId: string): Promise<void> {
    await this.prisma.device.updateMany({
      where: { userId, installationId },
      data: { lastSeenAt: new Date() },
    });
  }
}

export interface PushTarget {
  deviceId: string;
  platform: DevicePlatform;
  locale: string | null;
  token: string;
}

/**
 * Binds a sealed token to the row it belongs to.
 *
 * AES-GCM's additional authenticated data. A ciphertext lifted from one row and
 * pasted into another fails to open rather than decrypting into a token that
 * would deliver to the wrong person's phone.
 */
function sealContext(userId: string, installationId: string): string {
  return `device:${userId}:${installationId}`;
}

/** The last four characters, for support and logs. Not a secret. */
function fingerprintOf(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

interface DeviceRow {
  id: string;
  platform: string;
  installationId: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  locale: string | null;
  pushToken: string | null;
  pushTokenFingerprint: string | null;
  pushTokenRejectedAt: Date | null;
  isActive: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

/**
 * The shape a client sees.
 *
 * `hasPushToken` rather than the token. There is deliberately no parameter that
 * turns the token back on: a boolean and four characters answer every question
 * a user or a support agent can legitimately ask.
 */
export function toDto(row: DeviceRow): DeviceDto {
  return {
    id: row.id,
    platform: row.platform as DevicePlatform,
    installationId: row.installationId,
    model: row.model,
    osVersion: row.osVersion,
    appVersion: row.appVersion,
    locale: row.locale,
    hasPushToken: row.pushToken !== null,
    pushTokenFingerprint: row.pushTokenFingerprint,
    pushTokenRejectedAt: row.pushTokenRejectedAt?.toISOString() ?? null,
    isActive: row.isActive,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
