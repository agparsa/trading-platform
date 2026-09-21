import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withTenant } from '@tp/tenancy';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PushDeliveriesService } from '../../src/notifications/push-deliveries.service';
import {
  DEFAULT_TENANT_ID,
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The admin view over `push_deliveries` — the one the notification docs had
 * described since the push phase, and which did not exist. These tests write
 * rows the way the worker does and read them the way the screen will.
 */
suite('Push deliveries (integration)', () => {
  let prisma: PrismaClient;
  let service: PushDeliveriesService;
  let alice: string;
  let bob: string;
  const scope = { tenantId: DEFAULT_TENANT_ID, slug: 'default' };

  const device = (userId: string, platform: 'IOS' | 'ANDROID' | 'WEB', suffix: string) =>
    prisma.device.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        platform,
        installationId: `inst-${suffix}`,
        pushToken: `sealed-token-${suffix}`,
        pushTokenFingerprint: `fp-${suffix}`,
        model: platform === 'IOS' ? 'iPhone 15 Pro' : null,
      },
    });

  const notification = (userId: string, kind: string, title: string) =>
    prisma.notification.create({
      data: { tenantId: DEFAULT_TENANT_ID, userId, kind, title, body: 'body' },
    });

  const delivery = (
    notificationId: string,
    deviceId: string,
    status: 'PENDING' | 'SENT' | 'FAILED' | 'DROPPED' | 'SKIPPED',
    extra: { errorCode?: string; createdAt?: Date } = {},
  ) =>
    prisma.pushDelivery.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        notificationId,
        deviceId,
        status,
        attempts: 1,
        errorCode: extra.errorCode ?? null,
        sentAt: status === 'SENT' ? new Date() : null,
        ...(extra.createdAt === undefined ? {} : { createdAt: extra.createdAt }),
      },
    });

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    service = new PushDeliveriesService(prisma as unknown as PrismaService);
    alice = (await createAccount(prisma, { email: 'alice@test.local' })).userId;
    bob = (await createAccount(prisma, { email: 'bob@test.local' })).userId;
  });

  it('lists deliveries newest first, naming the person, the notice and the device — never the token', async () => {
    const phone = await device(alice, 'IOS', 'a1');
    const filled = await notification(alice, 'order.filled', 'Order filled');
    const margin = await notification(alice, 'risk.margin_call', 'Margin call');
    await delivery(filled.id, phone.id, 'SENT', { createdAt: new Date('2026-09-21T10:00:00Z') });
    await delivery(margin.id, phone.id, 'FAILED', {
      errorCode: 'UNAVAILABLE',
      createdAt: new Date('2026-09-21T11:00:00Z'),
    });

    const rows = await withTenant(scope, () => service.list({}));
    expect(rows.map((row) => row.notification.kind)).toEqual(['risk.margin_call', 'order.filled']);
    expect(rows[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'UNAVAILABLE',
      notification: { title: 'Margin call', userEmail: 'alice@test.local', userId: alice },
      device: {
        platform: 'IOS',
        model: 'iPhone 15 Pro',
        tokenFingerprint: 'fp-a1',
        isActive: true,
      },
    });
    // The sealed token is not a field of the view at all — not redacted, absent.
    expect(JSON.stringify(rows)).not.toContain('sealed-token');
    expect(Object.keys(rows[0]!.device)).not.toContain('pushToken');
  });

  it('filters by status, by person, by kind prefix and by error code', async () => {
    const aPhone = await device(alice, 'ANDROID', 'a2');
    const bPhone = await device(bob, 'WEB', 'b1');
    const n1 = await notification(alice, 'order.filled', 'a');
    const n2 = await notification(alice, 'order.rejected', 'b');
    const n3 = await notification(bob, 'security.sign_in', 'c');
    await delivery(n1.id, aPhone.id, 'SENT');
    await delivery(n2.id, aPhone.id, 'DROPPED', { errorCode: 'UNREGISTERED' });
    await delivery(n3.id, bPhone.id, 'SKIPPED');

    const dropped = await withTenant(scope, () => service.list({ status: 'DROPPED' }));
    expect(dropped.map((row) => row.notification.kind)).toEqual(['order.rejected']);

    const bobs = await withTenant(scope, () => service.list({ userId: bob }));
    expect(bobs.map((row) => row.notification.userEmail)).toEqual(['bob@test.local']);

    const orders = await withTenant(scope, () => service.list({ kind: 'order.' }));
    expect(orders).toHaveLength(2);

    const unregistered = await withTenant(scope, () => service.list({ errorCode: 'UNREGISTERED' }));
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]?.device.platform).toBe('ANDROID');
  });

  it('clamps the page to 500 and defaults to 100', async () => {
    const phone = await device(alice, 'WEB', 'a3');
    for (let i = 0; i < 120; i += 1) {
      const n = await notification(alice, 'order.filled', `n${i}`);
      await delivery(n.id, phone.id, 'SENT');
    }
    expect(await withTenant(scope, () => service.list({}))).toHaveLength(100);
    expect(await withTenant(scope, () => service.list({ limit: 5 }))).toHaveLength(5);
    expect(await withTenant(scope, () => service.list({ limit: 9_999 }))).toHaveLength(120);
  });

  it('summarises outcomes, error codes and platforms over a window from the same rows', async () => {
    const ios = await device(alice, 'IOS', 'a4');
    const android = await device(bob, 'ANDROID', 'b2');
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const [status, code] of [
      ['SENT', undefined],
      ['SENT', undefined],
      ['FAILED', 'UNAVAILABLE'],
      ['DROPPED', 'UNREGISTERED'],
      ['DROPPED', 'UNREGISTERED'],
    ] as const) {
      const n = await notification(alice, 'order.filled', 'x');
      await delivery(n.id, ios.id, status, code === undefined ? {} : { errorCode: code });
    }
    const skipped = await notification(bob, 'order.filled', 'y');
    await delivery(skipped.id, android.id, 'SKIPPED');
    // Outside the window: must not be counted.
    const stale = await notification(bob, 'order.filled', 'z');
    await delivery(stale.id, android.id, 'FAILED', { errorCode: 'OLD', createdAt: old });

    const since = new Date(Date.now() - 86_400_000);
    const summary = await withTenant(scope, () => service.summary(since));
    expect(summary.total).toBe(6);
    expect(summary.counts).toEqual({ PENDING: 0, SENT: 2, FAILED: 1, DROPPED: 2, SKIPPED: 1 });
    expect(summary.errors).toEqual([
      { code: 'UNREGISTERED', count: 2 },
      { code: 'UNAVAILABLE', count: 1 },
    ]);
    expect(summary.platforms).toEqual([
      { platform: 'ANDROID', attempted: 1, sent: 0 },
      { platform: 'IOS', attempted: 5, sent: 2 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('OLD');
  });

  it("does not show another firm's deliveries", async () => {
    const otherTenant = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherTenant, slug: 'other-firm' }, async () => {
      const otherUser = await prisma.user.create({
        data: {
          tenantId: otherTenant,
          email: 'carol@other.local',
          passwordHash: 'x',
          displayName: 'Carol',
          role: 'USER',
        },
      });
      const otherDevice = await prisma.device.create({
        data: {
          tenantId: otherTenant,
          userId: otherUser.id,
          platform: 'WEB',
          installationId: 'o1',
        },
      });
      const otherNotice = await prisma.notification.create({
        data: {
          tenantId: otherTenant,
          userId: otherUser.id,
          kind: 'order.filled',
          title: 't',
          body: 'b',
        },
      });
      await prisma.pushDelivery.create({
        data: {
          tenantId: otherTenant,
          notificationId: otherNotice.id,
          deviceId: otherDevice.id,
          status: 'SENT',
        },
      });
    });
    const mine = await device(alice, 'IOS', 'a5');
    const n = await notification(alice, 'order.filled', 'mine');
    await delivery(n.id, mine.id, 'SENT');

    const rows = await withTenant(scope, () => service.list({}));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notification.userEmail).toBe('alice@test.local');
    const summary = await withTenant(scope, () => service.summary(new Date(0)));
    expect(summary.total).toBe(1);
  });
});
