import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { NotificationCategory } from '@tp/shared-types';
import { NotificationMailer, type NotificationEmail } from '../../src/email/notification-mailer';
import { NotificationsService } from '../../src/jobs/notifications.service';
import { NoopPushProvider } from '../../src/push/noop-push.provider';
import { PushService } from '../../src/push/push.service';
import type { PrismaService } from '../../src/prisma.service';
import { DEFAULT_TENANT_ID, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

class RecordingMailer extends NotificationMailer {
  readonly configured = true;
  readonly sent: NotificationEmail[] = [];
  failing = false;
  async send(message: NotificationEmail): Promise<void> {
    if (this.failing) throw new Error('454 TLS not available');
    this.sent.push(message);
  }
}

/**
 * Notifications by email: a margin call reaches a trader with no screen open,
 * on a phone that may have no push.
 *
 * Driven through the worker's real delivery path — the job, the row, the
 * preferences, the user — with only the mail server replaced.
 */
suite('Notification email (integration)', () => {
  let prisma: PrismaClient;
  let mailer: RecordingMailer;
  let notifications: NotificationsService;
  let userId: string;
  let accountId: string;

  const job = (overrides: Record<string, unknown> = {}) => ({
    tenantId: DEFAULT_TENANT_ID,
    userId,
    kind: 'risk.margin_call',
    severity: 'CRITICAL',
    title: 'Margin call',
    body: 'Margin level is 48.2%. Positions close at 30%.',
    data: {},
    accountId,
    dedupeKey: null,
    ...overrides,
  });

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    mailer = new RecordingMailer();
    const service = prisma as unknown as PrismaService;
    const secrets = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
    notifications = new NotificationsService(
      service,
      new PushService(service, new NoopPushProvider(), secrets),
      mailer,
      'https://trade.example.com/',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mailer.sent.length = 0;
    mailer.failing = false;
    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'trader@example.com',
        passwordHash: 'not-a-real-hash',
        displayName: 'Trader',
        emailVerified: true,
      },
    });
    userId = user.id;
    accountId = (
      await prisma.account.create({
        data: { tenantId: DEFAULT_TENANT_ID, userId, number: 'TP-100284', currency: 'USD' },
      })
    ).id;
  });

  const emailedAt = async (id: string | null) =>
    (await prisma.notification.findUniqueOrThrow({ where: { id: id! } })).emailedAt;

  it('emails a margin call to the verified address, names the account, and records it', async () => {
    const result = await notifications.deliver(job());
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail!.to).toBe('trader@example.com');
    expect(mail!.subject).toBe('Action needed: Margin call');
    expect(mail!.text).toContain('Margin level is 48.2%');
    expect(mail!.text).toContain('Account: TP-100284');
    expect(mail!.text).toContain('https://trade.example.com/terminal');
    expect(await emailedAt(result.id)).toBeInstanceOf(Date);
  });

  it('does not email a fill, which nobody asked to be emailed', async () => {
    const result = await notifications.deliver(
      job({ kind: 'position.opened', severity: 'INFO', title: 'Position opened' }),
    );
    expect(mailer.sent).toHaveLength(0);
    expect(await emailedAt(result.id)).toBeNull();
  });

  it('emails what the trader turned on, and not what they turned off', async () => {
    await prisma.notificationPreference.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        category: NotificationCategory.TRADE_OPENED,
        email: true,
      },
    });
    await prisma.notificationPreference.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        category: NotificationCategory.RISK_ALERT,
        email: false,
      },
    });
    await notifications.deliver(
      job({ kind: 'position.opened', severity: 'INFO', title: 'Position opened' }),
    );
    await notifications.deliver(job());
    expect(mailer.sent.map((mail) => mail.subject)).toEqual(['Position opened']);
  });

  it('never mails an address nobody has shown they read', async () => {
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });
    const result = await notifications.deliver(job());
    expect(mailer.sent).toHaveLength(0);
    expect(await emailedAt(result.id)).toBeNull();
  });

  it('mails once for one event, however many times it is raised', async () => {
    await notifications.deliver(job({ dedupeKey: 'margin:TP-100284:1' }));
    await notifications.deliver(job({ dedupeKey: 'margin:TP-100284:1' }));
    expect(mailer.sent).toHaveLength(1);
  });

  it('keeps the notice when the mail server refuses it, and does not call it emailed', async () => {
    mailer.failing = true;
    const result = await notifications.deliver(job());
    expect(result.created).toBe(true);
    expect(await emailedAt(result.id)).toBeNull();
  });
});
