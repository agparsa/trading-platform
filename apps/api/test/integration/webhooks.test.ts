import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { WebhooksService } from '../../src/webhooks/webhooks.service';
import { FeaturesService } from '../../src/features/features.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SecretBoxService } from '../../src/common/crypto/crypto.module';
import {
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

/**
 * Registering where a firm's events go (§49).
 *
 * The refusals are the substance: an address this platform must not call, a
 * secret that must not be readable back, an endpoint that must not be
 * visible to another firm. The happy path is one test; the rest are the
 * ways this could quietly become an exfiltration channel.
 */
suite('webhooks', () => {
  let prisma: PrismaClient;
  let box: SecretBox;
  let service: WebhooksService;
  let admin: string;

  const build = (allowHttp = false) =>
    new WebhooksService(
      prisma as unknown as PrismaService,
      box as unknown as SecretBoxService,
      new AuditService(prisma as unknown as PrismaService),
      new ConfigService({ WEBHOOK_ALLOW_HTTP: allowHttp } as never) as never,
      new FeaturesService(
        prisma as unknown as PrismaService,
        new AuditService(prisma as unknown as PrismaService),
      ),
    );

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    box = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    service = build();
    admin = (await createAccount(prisma, { balance: '0' })).userId;
  });

  const create = (over: Partial<Parameters<WebhooksService['create']>[0]> = {}, svc = service) =>
    withTenant(TENANT, () =>
      svc.create({
        actorId: admin,
        url: 'https://hooks.example.com/tp',
        description: 'The back office',
        events: ['order.filled'],
        ...over,
      }),
    );

  it('registers an endpoint, shows the secret once, and stores it sealed', async () => {
    const { endpoint, secret } = await create();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.secretSealed).not.toContain(secret);
    expect(box.open(row.secretSealed, row.id)).toBe(secret);
    expect(row.secretHint).toBe(secret.slice(-4));
    expect(row.events).toEqual(['order.filled']);

    const listed = await withTenant(TENANT, () => service.list());
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed[0]?.secretHint).toBe(secret.slice(-4));
  });

  it.each([
    ['not a url', /not a URL/],
    ['http://hooks.example.com/', /https/],
    ['https://user:pw@hooks.example.com/', /username or password/],
    ['https://localhost:4000/admin', /local host/],
    ['https://127.0.0.1/', /private, loopback/],
    ['https://169.254.169.254/latest/meta-data/', /private, loopback/],
    ['https://10.0.0.5/', /private, loopback/],
    ['https://[::1]/', /private, loopback/],
  ])('refuses %s', async (url, wording) => {
    await expect(create({ url })).rejects.toThrow(wording);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  it('allows plain http only when the deployment says so', async () => {
    await expect(create({ url: 'http://receiver.example.com/' })).rejects.toThrow(/https/);
    const { endpoint } = await create({ url: 'http://receiver.example.com/' }, build(true));
    expect(endpoint.url).toBe('http://receiver.example.com/');
  });

  it('refuses to register an endpoint when the platform has not switched webhooks on for the firm', async () => {
    await prisma.tenantFeature.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        key: 'webhooks',
        enabled: false,
        authority: 'PLATFORM',
        note: 'not on this plan',
        updatedByUserId: admin,
      },
    });
    await expect(create()).rejects.toThrow(/not switched on/);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  it('refuses an event type the outbox does not carry', async () => {
    await expect(create({ events: ['order.filled', 'coffee.brewed'] })).rejects.toThrow(
      /coffee\.brewed/,
    );
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  /**
   * The catalogue and the producers have to agree in both directions. A type
   * offered but never written is a subscription that reassures — the thing
   * §49's own note said was not to be shipped — and a type written but not
   * offered can never be subscribed to, so it is delivered only to endpoints
   * that asked for everything.
   */
  it('offers the platform\'s own two events, and accepts a subscription to them', async () => {
    const offered = service.eventTypes();
    expect(offered).toContain('reconciliation.mismatch');
    expect(offered).toContain('security.alert');
    // Trading's events are still all there.
    expect(offered).toContain('order.filled');
    expect(offered).toContain('liquidation');

    const { endpoint } = await create({
      events: ['security.alert', 'reconciliation.mismatch'],
    });
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.events).toEqual(['reconciliation.mismatch', 'security.alert']);
  });

  it('rotates the secret, keeps the old one for a day, and shows the new one once', async () => {
    const { endpoint, secret: first } = await create();
    const rotated = await withTenant(TENANT, () =>
      service.rotateSecret({ actorId: admin, id: endpoint.id }),
    );
    expect(rotated.secret).not.toBe(first);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(box.open(row.secretSealed, row.id)).toBe(rotated.secret);
    expect(box.open(row.previousSecretSealed as string, row.id)).toBe(first);
    expect(row.previousSecretExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 23 * 60 * 60 * 1000,
    );
  });

  it('turning an endpoint back on re-schedules what was parked while it was off', async () => {
    const { endpoint } = await create();
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        eventId: '00000000-0000-4000-8000-000000000001',
        eventType: 'order.filled',
        aggregateType: 'order',
        aggregateId: 'o1',
        payload: {},
      },
    });
    const parked = await prisma.webhookDelivery.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        endpointId: endpoint.id,
        outboxEventId: event.id,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'FAILED',
        nextAttemptAt: null,
      },
    });

    await withTenant(TENANT, () =>
      service.setEnabled({ actorId: admin, id: endpoint.id, enabled: false }),
    );
    let row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toMatch(/by a person/);

    await withTenant(TENANT, () =>
      service.setEnabled({ actorId: admin, id: endpoint.id, enabled: true }),
    );
    row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.enabled).toBe(true);
    expect(row.disabledReason).toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: parked.id } });
    expect(delivery.nextAttemptAt).not.toBeNull();
  });

  it('replays a delivery as a new row that points at the original', async () => {
    const { endpoint } = await create();
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        eventId: '00000000-0000-4000-8000-000000000002',
        eventType: 'order.filled',
        aggregateType: 'order',
        aggregateId: 'o2',
        payload: {},
      },
    });
    const original = await prisma.webhookDelivery.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        endpointId: endpoint.id,
        outboxEventId: event.id,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'DELIVERED',
      },
    });

    const replay = await withTenant(TENANT, () =>
      service.replay({ actorId: admin, deliveryId: original.id }),
    );
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: replay.id } });
    expect(row.replayOfId).toBe(original.id);
    expect(row.status).toBe('PENDING');
    expect(row.requestedByUserId).toBe(admin);

    // A second replay of the same event is allowed — the partial unique index
    // binds originals only.
    await expect(
      withTenant(TENANT, () => service.replay({ actorId: admin, deliveryId: original.id })),
    ).resolves.toBeDefined();
  });

  it('refuses to replay to an endpoint that is switched off', async () => {
    const { endpoint } = await create();
    const event = await prisma.outboxEvent.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        eventId: '00000000-0000-4000-8000-000000000003',
        eventType: 'order.filled',
        aggregateType: 'order',
        aggregateId: 'o3',
        payload: {},
      },
    });
    const original = await prisma.webhookDelivery.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        endpointId: endpoint.id,
        outboxEventId: event.id,
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'EXHAUSTED',
      },
    });
    await withTenant(TENANT, () =>
      service.setEnabled({ actorId: admin, id: endpoint.id, enabled: false }),
    );
    await expect(
      withTenant(TENANT, () => service.replay({ actorId: admin, deliveryId: original.id })),
    ).rejects.toThrow(/switched off/);
  });

  it('never shows one firm another firm’s endpoints or deliveries', async () => {
    const otherId = await createTenant(prisma, 'other-firm');
    const other = { tenantId: otherId, slug: 'other-firm' };
    const otherAdmin = (
      await withTenant(other, () =>
        createAccount(prisma, { tenantId: otherId, email: 'other@test.local' }),
      )
    ).userId;

    const mine = await create();
    await withTenant(other, () =>
      service.create({
        actorId: otherAdmin,
        url: 'https://theirs.example.com/',
        description: 'theirs',
        events: [],
      }),
    );

    expect((await withTenant(TENANT, () => service.list())).map((row) => row.url)).toEqual([
      'https://hooks.example.com/tp',
    ]);
    expect((await withTenant(other, () => service.list())).map((row) => row.url)).toEqual([
      'https://theirs.example.com/',
    ]);
    await expect(withTenant(other, () => service.deliveries(mine.endpoint.id, 10))).rejects.toThrow(
      /No such webhook endpoint/,
    );
    await expect(
      withTenant(other, () => service.rotateSecret({ actorId: otherAdmin, id: mine.endpoint.id })),
    ).rejects.toThrow(/No such webhook endpoint/);
    await expect(
      withTenant(other, () => service.remove(otherAdmin, mine.endpoint.id)),
    ).rejects.toThrow(/No such webhook endpoint/);
    expect(await withoutTenantScope('assertion', () => prisma.webhookEndpoint.count())).toBe(2);
  });

  it('audits every change without ever writing the secret', async () => {
    const { endpoint, secret } = await create();
    const rotated = await withTenant(TENANT, () =>
      service.rotateSecret({ actorId: admin, id: endpoint.id }),
    );
    await withTenant(TENANT, () =>
      service.setEnabled({ actorId: admin, id: endpoint.id, enabled: false }),
    );
    await withTenant(TENANT, () => service.remove(admin, endpoint.id));

    const rows = await prisma.auditLog.findMany({
      where: { resourceType: 'WebhookEndpoint' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual([
      'WEBHOOK_ENDPOINT_CREATED',
      'WEBHOOK_SECRET_ROTATED',
      'WEBHOOK_ENDPOINT_DISABLED',
      'WEBHOOK_ENDPOINT_DELETED',
    ]);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(rotated.secret);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });
});
