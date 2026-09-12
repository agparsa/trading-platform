import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DevicePlatform } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { DevicesService } from '../../src/devices/devices.service';
import { DevicesController } from '../../src/devices/devices.controller';
import { AuditService } from '../../src/common/audit/audit.service';
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
    const device = (await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
      model: 'iPhone 15 Pro',
    })).device;

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
    const ipad = (await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPAD,
      pushToken: TOKEN_B,
    })).device;
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
    const device = (await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    })).device;

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
    const device = (await devices.register(other.id, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    })).device;

    await expect(devices.deactivate(userId, device.id)).rejects.toThrow();
    // And it is still receiving, which is what "refused" has to mean.
    expect(await devices.pushTargets(other.id)).toHaveLength(1);
  });

  /**
   * The three things a register call can be, which used to be one thing.
   *
   * The app re-registers on every launch, so the common case by far is a
   * refresh — and until `register` said so, every launch was audited as a new
   * device. What is pinned here is that the *caller* can tell them apart,
   * because that is what the audit row and the security feed are built on.
   */
  it('says whether a register created, revived or merely refreshed a device', async () => {
    const first = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    expect(first.change).toBe('REGISTERED');

    const relaunch = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
    });
    expect(relaunch.change).toBe('REFRESHED');

    await devices.deactivate(userId, first.device.id);
    const back = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    // The person revoked their own phone and signed in on it again: consent
    // expressed by action, and the device comes back.
    expect(back.change).toBe('REVIVED');
    expect(back.device.isActive).toBe(true);
    expect(await devices.pushTargets(userId)).toHaveLength(1);
  });

  /**
   * The lost phone.
   *
   * Before this, a staff revocation was undone by the very act it defends
   * against: staff revoke the handset, the thief opens the app, the app
   * re-registers, `isActive` goes back to true and the notifications about
   * this person's money resume on the stolen device — silently.
   */
  it('does not let a relaunch undo a revocation staff applied', async () => {
    const { device } = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });

    await devices.revokeForUser(userId, device.id);
    expect(await devices.pushTargets(userId)).toEqual([]);

    const relaunch = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_B,
    });

    expect(relaunch.change).toBe('REFUSED_REVIVAL');
    expect(relaunch.device.isActive).toBe(false);
    // And the token it offered was not taken: there is nowhere it should go.
    expect(await devices.pushTargets(userId)).toEqual([]);
    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushToken).toBeNull();
    expect(row.revokedByStaffAt).not.toBeNull();
    // lastSeenAt still moves: the handset is still out there and still asking,
    // which is exactly what an investigator wants to be able to see.
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });

  it('cannot be talked round by the person revoking and re-registering', async () => {
    const { device } = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    await devices.revokeForUser(userId, device.id);

    // The obvious way round the control, if `deactivate` cleared the stamp.
    await devices.deactivate(userId, device.id).catch(() => undefined);
    const relaunch = await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_B,
    });
    expect(relaunch.change).toBe('REFUSED_REVIVAL');
    expect(await devices.pushTargets(userId)).toEqual([]);
  });

  it('restores a revoked device without putting its notifications back by itself', async () => {
    const { device } = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    });
    await devices.revokeForUser(userId, device.id);
    await devices.restoreForUser(userId, device.id);

    const restored = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(restored.revokedByStaffAt).toBeNull();
    // Still off, still tokenless: staff lifting the block does not re-arm a
    // handset nobody has confirmed is back in the right hands.
    expect(restored.isActive).toBe(false);
    expect(restored.pushToken).toBeNull();
    expect(await devices.pushTargets(userId)).toEqual([]);

    // The device itself asking is what brings it back.
    const relaunch = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_B,
    });
    expect(relaunch.change).toBe('REVIVED');
    expect(await devices.pushTargets(userId)).toHaveLength(1);
  });

  it('never shows staff a push token, and never one tenant another tenant’s devices', async () => {
    const { device } = await devices.register(userId, {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
      model: 'iPhone 15 Pro',
    });

    const [seen] = await devices.listFor(userId);
    expect(seen?.id).toBe(device.id);
    expect(seen?.model).toBe('iPhone 15 Pro');
    expect(seen?.revokedByStaffAt).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(TOKEN_A);
    expect(Object.keys(seen ?? {})).not.toContain('pushToken');

    const otherTenantId = await createTenant(prisma, 'nosy-tenant');
    const throughOtherTenant = await withTenant(
      { tenantId: otherTenantId, slug: 'nosy-tenant' },
      async () => devices.listFor(userId),
    );
    expect(throughOtherTenant).toEqual([]);
    await expect(
      withTenant({ tenantId: otherTenantId, slug: 'nosy-tenant' }, async () =>
        devices.revokeForUser(userId, device.id),
      ),
    ).rejects.toThrow();
    const untouched = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(untouched.revokedByStaffAt).toBeNull();
    expect(untouched.isActive).toBe(true);
  });

  /**
   * The audit log counts registrations, not app launches.
   *
   * This is the whole point of `register` reporting what it did. The app
   * re-registers every time it opens, and a row per launch saying
   * `DEVICE_REGISTERED` meant the one row that mattered — a phone this account
   * had never been seen on — sat somewhere in the thousands. An investigator
   * cannot read that, so in practice it was not recorded at all.
   */
  it('writes one audit row per real change and none for a relaunch', async () => {
    const controller = new DevicesController(
      devices,
      new AuditService(prisma as unknown as PrismaService),
    );
    const request = {
      get: () => 'a phone',
      headers: {},
      socket: {},
    } as never;
    const user = { id: userId } as never;
    const body = {
      platform: DevicePlatform.IOS,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    } as never;

    await controller.register(user, body, request);
    await controller.register(user, body, request);
    await controller.register(user, body, request);

    const actions = await prisma.auditLog.findMany({
      where: { resourceType: 'Device' },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(actions.map((row) => row.action)).toEqual(['DEVICE_REGISTERED']);

    // And the one row that means something reaches the person's own feed.
    const events = await prisma.securityEvent.findMany({ where: { userId } });
    expect(events.map((event) => event.kind)).toEqual(['DEVICE_REGISTERED']);
    expect(events[0]?.severity).toBe('WARNING');
  });

  it('drops a device the provider has rejected', async () => {
    const device = (await devices.register(userId, {
      platform: DevicePlatform.ANDROID,
      installationId: IPHONE,
      pushToken: TOKEN_A,
    })).device;

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
