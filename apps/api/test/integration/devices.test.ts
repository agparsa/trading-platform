import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DevicePlatform } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { DevicesService } from '../../src/devices/devices.service';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const IPHONE = 'installation-iphone-0001';
const IPAD = 'installation-ipad-0002';
const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222';

/**
 * Devices and push tokens.
 *
 * Three properties are load-bearing and each has a specific failure it is here
 * to prevent: a rotated token must not create a second row (the trader hears
 * everything twice), a token must never leave the service (anyone holding one
 * can send a message that looks like it came from us), and a revoked device
 * must stop being a delivery target immediately (the whole point of revoking).
 */
suite('Devices and push tokens (integration)', () => {
  let prisma: PrismaClient;
  let devices: DevicesService;
  let secrets: SecretBox;
  let userId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    secrets = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
    devices = new DevicesService(prisma as unknown as PrismaService, secrets as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'trader@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Trader',
      },
    });
    userId = user.id;
  });

  it('registers an installation and hands back no token', async () => {
    const device = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
      model: 'iPhone 15 Pro',
    });

    expect(device.hasPushToken).toBe(true);
    expect(device.pushTokenFingerprint).toBe('1111');
    expect(JSON.stringify(device)).not.toContain(TOKEN_A);

    /**
     * The exact key set, not merely "the plaintext is absent".
     *
     * Asserting only on the plaintext let a mutation that returned the *sealed*
     * token pass — the ciphertext is not the token, so the substring check saw
     * nothing wrong. It is still an exposure nobody asked for, and the way to
     * catch any future field is to pin what a device may contain rather than to
     * enumerate what it may not.
     */
    expect(Object.keys(device).sort()).toEqual(
      [
        'appVersion',
        'createdAt',
        'hasPushToken',
        'id',
        'installationId',
        'isActive',
        'lastSeenAt',
        'locale',
        'model',
        'osVersion',
        'platform',
        'pushTokenFingerprint',
        'pushTokenRejectedAt',
      ].sort(),
    );
  });

  it('seals the token at rest', async () => {
    await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    const row = await prisma.device.findFirstOrThrow({ where: { userId } });
    expect(row.pushToken).not.toBeNull();
    expect(row.pushToken).not.toContain(TOKEN_A);
    // And it is the real thing, not merely unreadable.
    expect(secrets.open(row.pushToken!, `device:${userId}:${IPHONE}`)).toBe(TOKEN_A);
  });

  it('will not deliver a sealed token that was moved to another row', async () => {
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    const ipad = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPAD,
      pushToken: TOKEN_B,
    });
    const iphoneRow = await prisma.device.findFirstOrThrow({
      where: { userId, installationId: IPHONE },
    });

    /**
     * The attack this defends against, performed rather than described.
     *
     * Someone with write access to the table copies one device's ciphertext
     * onto another device's row. Without the installation id in the AAD it
     * decrypts cleanly, and the iPad's notifications start arriving on the
     * iPhone. An earlier version of this test asserted only that opening with a
     * *different* context throws — which stayed true when the installation id
     * was dropped from the context entirely, because the two contexts still
     * differed. This one does not: it goes through `pushTargets`, the code that
     * actually decides where a notification goes.
     */
    await prisma.device.update({
      where: { id: ipad.id },
      data: { pushToken: iphoneRow.pushToken },
    });

    const targets = await devices.pushTargets(userId);
    expect(targets.map((target) => target.deviceId)).not.toContain(ipad.id);
    expect(targets).toHaveLength(1);
  });

  it('updates the row when the provider rotates the token', async () => {
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_B,
    });

    const rows = await prisma.device.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);

    const targets = await devices.pushTargets(userId);
    expect(targets.map((target) => target.token)).toEqual([TOKEN_B]);
  });

  it('keeps a working token when the app re-registers without one', async () => {
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    // Every launch calls register; notification permission is granted once,
    // later. A launch must not silence the device.
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      appVersion: '1.2.0',
    });

    const targets = await devices.pushTargets(userId);
    expect(targets.map((target) => target.token)).toEqual([TOKEN_A]);
  });

  it('treats two installations as two devices', async () => {
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPAD,
      pushToken: TOKEN_B,
    });

    const targets = await devices.pushTargets(userId);
    expect(targets.map((target) => target.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });

  it('stops delivering to a revoked device and destroys its token', async () => {
    const device = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    await devices.deactivate(userId, device.id);

    expect(await devices.pushTargets(userId)).toEqual([]);
    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    // Not merely flagged. A deactivated row still holding a live token is one
    // bug away from waking a phone whose owner revoked it.
    expect(row.pushToken).toBeNull();
    expect(row.isActive).toBe(false);
  });

  it("refuses to revoke somebody else's device", async () => {
    const other = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'other@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Other',
      },
    });
    const device = await devices.register(other.id, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    await expect(devices.deactivate(userId, device.id)).rejects.toThrow();
    // And it is still receiving, which is what "refused" has to mean.
    expect(await devices.pushTargets(other.id)).toHaveLength(1);
  });

  it('drops a device the provider has rejected', async () => {
    const device = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    await devices.markTokenRejected(device.id);

    expect(await devices.pushTargets(userId)).toEqual([]);
    // The reason survives, so support can say why it stopped.
    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushTokenRejectedAt).not.toBeNull();
    expect(row.pushTokenFingerprint).toBe('1111');
  });

  it("does not deliver one tenant's notification to another tenant's device", async () => {
    await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    const otherTenantId = await createTenant(prisma, 'other-tenant');
    const intruderTargets = await withTenant(
      { tenantId: otherTenantId, slug: 'other-tenant' },
      async () => devices.pushTargets(userId),
    );

    // Same userId, different tenant in scope. The tenant extension filters the
    // query, so the answer is nothing — not "the row, because the userId
    // matched".
    expect(intruderTargets).toEqual([]);

    // And the original tenant is unaffected, which is what makes the assertion
    // above about isolation rather than about a broken query.
    const ownTargets = await withTenant(
      { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG },
      async () => devices.pushTargets(userId),
    );
    expect(ownTargets).toHaveLength(1);
  });
});
