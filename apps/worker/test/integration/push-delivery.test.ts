import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PushOutcome } from '@tp/push-core';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { DevicePlatform, NotificationCategory } from '@tp/shared-types';
import { NotificationsService } from '../../src/jobs/notifications.service';
import { PushService } from '../../src/push/push.service';
import { PushProvider, type PushEnvelope, type PushResult } from '../../src/push/push.port';
import type { PrismaService } from '../../src/prisma.service';
import { DEFAULT_TENANT_ID, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const TOKEN = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111';
const INSTALLATION = 'installation-iphone-0001';

/** Records what it was asked to send, and answers however the test says. */
class RecordingProvider extends PushProvider {
  readonly name = 'recording';
  readonly sent: PushEnvelope[] = [];
  outcome: PushOutcome = PushOutcome.SENT;
  errorCode: string | null = null;

  async send(envelope: PushEnvelope): Promise<PushResult> {
    this.sent.push(envelope);
    return {
      deviceId: envelope.deviceId,
      outcome: this.outcome,
      errorCode: this.errorCode,
      providerMessageId: this.outcome === PushOutcome.SENT ? 'projects/x/messages/1' : null,
    };
  }
}

/**
 * One event, one push.
 *
 * §26 is the requirement and it is the one most likely to be quietly wrong: a
 * WebSocket reconnect, a retried job, or two API instances both noticing the
 * same margin call must not make a trader's phone buzz twice. Everything below
 * is a way for that to happen, exercised through the real delivery path rather
 * than asserted about it.
 */
suite('Push delivery (integration)', () => {
  let prisma: PrismaClient;
  let notifications: NotificationsService;
  let provider: RecordingProvider;
  let secrets: SecretBox;
  let userId: string;
  let deviceId: string;

  const job = (overrides: Record<string, unknown> = {}) => ({
    tenantId: DEFAULT_TENANT_ID,
    userId,
    kind: 'position.opened',
    severity: 'INFO',
    title: 'Position opened',
    body: 'BTC/USDT BUY 0.10',
    data: {},
    accountId: null,
    dedupeKey: null,
    ...overrides,
  });

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    secrets = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
    provider = new RecordingProvider();
    notifications = new NotificationsService(
      prisma as unknown as PrismaService,
      new PushService(prisma as unknown as PrismaService, provider, secrets),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    provider.sent.length = 0;
    provider.outcome = PushOutcome.SENT;
    provider.errorCode = null;

    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'trader@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Trader',
      },
    });
    userId = user.id;

    const device = await prisma.device.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        platform: DevicePlatform.IOS,
        installationId: INSTALLATION,
        pushToken: secrets.seal(TOKEN, `device:${userId}:${INSTALLATION}`),
        pushTokenFingerprint: '1111',
      },
    });
    deviceId = device.id;
  });

  it('pushes once for a new notification', async () => {
    const result = await notifications.deliver(job());

    expect(result.created).toBe(true);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.token).toBe(TOKEN);
    expect(provider.sent[0]?.category).toBe(NotificationCategory.TRADE_OPENED);
  });

  it('does not push a second time for the same event', async () => {
    const deduped = job({ dedupeKey: 'position:abc:opened' });
    await notifications.deliver(deduped);
    await notifications.deliver(deduped);

    // Two producers noticing the same fill, or a job retried after a timeout
    // that had in fact succeeded. One row, one buzz.
    expect(await prisma.notification.count({ where: { userId } })).toBe(1);
    expect(provider.sent).toHaveLength(1);
  });

  it("carries the producer's event id so a client can discard the duplicate", async () => {
    await notifications.deliver(job({ data: { eventId: 'evt-12345' } }));
    expect(provider.sent[0]?.eventId).toBe('evt-12345');
  });

  it('falls back to the notification id when the producer sent no event id', async () => {
    const result = await notifications.deliver(job());
    expect(provider.sent[0]?.eventId).toBe(result.id);
  });

  it('records the attempt for the admin statistics', async () => {
    await notifications.deliver(job());

    const rows = await prisma.pushDelivery.findMany({ where: { deviceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it('marks the device rejected when the provider says the token is dead', async () => {
    provider.outcome = PushOutcome.DROP_TOKEN;
    provider.errorCode = 'UNREGISTERED';

    await notifications.deliver(job());

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.pushTokenRejectedAt).not.toBeNull();

    const delivery = await prisma.pushDelivery.findFirstOrThrow({ where: { deviceId } });
    expect(delivery.status).toBe('DROPPED');
    expect(delivery.errorCode).toBe('UNREGISTERED');
  });

  it('does not touch the device when the provider is merely unavailable', async () => {
    provider.outcome = PushOutcome.RETRY;
    provider.errorCode = 'UNAVAILABLE';

    await notifications.deliver(job());

    // The failure that must never delete a token: a brief outage would
    // otherwise unsubscribe the entire estate.
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.pushTokenRejectedAt).toBeNull();
    expect((await prisma.pushDelivery.findFirstOrThrow({ where: { deviceId } })).status).toBe(
      'FAILED',
    );
  });

  it('sends nothing when the user turned the category off, and says so', async () => {
    await prisma.notificationPreference.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        category: NotificationCategory.TRADE_OPENED,
        push: false,
      },
    });

    await notifications.deliver(job());

    expect(provider.sent).toHaveLength(0);
    // Recorded, because "we chose not to" and "we tried and failed" are
    // different answers to the same support question.
    const delivery = await prisma.pushDelivery.findFirstOrThrow({ where: { deviceId } });
    expect(delivery.status).toBe('SKIPPED');
    expect(delivery.errorCode).toBe('PREFERENCE');
  });

  it('still pushes a margin call to a user who turned everything off', async () => {
    await prisma.notificationSetting.create({
      data: { tenantId: DEFAULT_TENANT_ID, userId, tradingEnabled: false, pushEnabled: false },
    });

    await notifications.deliver(job({ kind: 'risk.margin_call', severity: 'WARNING' }));

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.category).toBe(NotificationCategory.RISK_ALERT);
  });

  it('skips a device whose token was already rejected', async () => {
    await prisma.device.update({
      where: { id: deviceId },
      data: { pushTokenRejectedAt: new Date() },
    });

    await notifications.deliver(job());

    // Sending again earns a rate-limit penalty from the provider and reaches
    // nobody.
    expect(provider.sent).toHaveLength(0);
  });

  it('does not fail the notification when the push path throws', async () => {
    class ExplodingProvider extends PushProvider {
      readonly name = 'exploding';
      async send(): Promise<PushResult> {
        throw new Error('the transport is on fire');
      }
    }
    const fragile = new NotificationsService(
      prisma as unknown as PrismaService,
      new PushService(prisma as unknown as PrismaService, new ExplodingProvider(), secrets),
    );

    // The row is already committed at this point. Throwing would retry the job,
    // which would find the row present and never push at all — strictly worse
    // than the original failure.
    const result = await fragile.deliver(job());
    expect(result.created).toBe(true);
    expect(await prisma.notification.count({ where: { userId } })).toBe(1);
  });

  it('reaches every device the person has', async () => {
    const second = 'installation-ipad-0002';
    await prisma.device.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        platform: DevicePlatform.ANDROID,
        installationId: second,
        pushToken: secrets.seal('another-token-2222', `device:${userId}:${second}`),
        pushTokenFingerprint: '2222',
      },
    });

    await notifications.deliver(job());

    expect(provider.sent).toHaveLength(2);
    expect(await prisma.pushDelivery.count()).toBe(2);
  });
});
