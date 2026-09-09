import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { OutboxEvent, PrismaClient } from '@prisma/client';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { verify } from '@tp/webhooks-core';
import { OutboxRelayService } from '../../src/jobs/outbox-relay.service';
import { WebhookDeliveryService } from '../../src/jobs/webhook-delivery.service';
import type { SendOutcome, SendRequest, Sender } from '../../src/jobs/webhook-sender';
import type { PrismaService } from '../../src/prisma.service';
import type { WorkerEnv } from '../../src/env';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, kind: 'BROKER' as const };
const SECRET = 'whsec_test_secret_for_the_receiver';

/**
 * Webhook delivery (§49), against a receiver this test controls.
 *
 * What is pinned: a delivery is signed so the receiver can verify it; a
 * failure is retried on the schedule and then kept as EXHAUSTED, never
 * deleted; an endpoint that fails deliveries in a row is switched off with
 * a reason; a relay handed the same event twice creates one delivery; and
 * one firm's endpoints never see another firm's events.
 */
suite('Webhook delivery (integration)', () => {
  let prisma: PrismaClient;
  let box: SecretBox;
  let userId: string;
  let accountId: string;

  /** The receiver: records every request, answers as told. */
  const received: SendRequest[] = [];
  let answer: () => SendOutcome = () => ({
    kind: 'response',
    status: 200,
    body: 'ok',
    durationMs: 5,
  });
  const sender: Sender = async (request) => {
    received.push(request);
    return answer();
  };

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
    received.length = 0;
    answer = () => ({ kind: 'response', status: 200, body: 'ok', durationMs: 5 });
    const account = await createAccount(prisma, { balance: '1000' });
    userId = account.userId;
    accountId = account.accountId;
  });

  function build(env: Partial<WorkerEnv> = {}, relay?: OutboxRelayService): WebhookDeliveryService {
    const service = new WebhookDeliveryService(
      prisma as unknown as PrismaService,
      new ConfigService({
        WEBHOOK_MAX_ATTEMPTS: 3,
        WEBHOOK_DISABLE_AFTER_FAILURES: 2,
        ...env,
      }) as never,
      relay,
      box,
      sender,
    );
    service.onModuleInit();
    return service;
  }

  async function endpoint(
    over: { tenantId?: string; events?: string[]; enabled?: boolean; url?: string } = {},
  ): Promise<string> {
    const tenantId = over.tenantId ?? DEFAULT_TENANT_ID;
    const owner =
      tenantId === DEFAULT_TENANT_ID
        ? userId
        : (
            await withTenant({ tenantId, slug: 'other', kind: 'BROKER' }, () =>
              createAccount(prisma, {
                tenantId,
                email: `owner-${tenantId.slice(0, 8)}@test.local`,
              }),
            )
          ).userId;
    const row = await withoutTenantScope('fixture', () =>
      prisma.webhookEndpoint.create({
        data: {
          tenantId,
          url: over.url ?? 'https://hooks.example.com/tp',
          description: 'test receiver',
          secretSealed: 'pending',
          secretHint: SECRET.slice(-4),
          events: over.events ?? [],
          enabled: over.enabled ?? true,
          createdByUserId: owner,
        },
      }),
    );
    await withoutTenantScope('fixture', () =>
      prisma.webhookEndpoint.update({
        where: { id: row.id },
        data: { secretSealed: box.seal(SECRET, row.id) },
      }),
    );
    return row.id;
  }

  let sequence = 0;
  async function event(over: { tenantId?: string; eventType?: string } = {}): Promise<OutboxEvent> {
    sequence += 1;
    return withoutTenantScope('fixture', () =>
      prisma.outboxEvent.create({
        data: {
          tenantId: over.tenantId ?? DEFAULT_TENANT_ID,
          eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          eventType: over.eventType ?? 'order.filled',
          aggregateType: 'order',
          aggregateId: `order-${sequence}`,
          accountId,
          payload: { orderId: `order-${sequence}`, volume: '0.10' },
        },
      }),
    );
  }

  const deliveries = (endpointId: string) =>
    withoutTenantScope('assertion', () =>
      prisma.webhookDelivery.findMany({ where: { endpointId }, orderBy: { createdAt: 'asc' } }),
    );

  it('records what is owed when the relay hands an event over, and sends nothing yet', async () => {
    const service = build();
    const endpointId = await endpoint();
    const row = await event();

    await withTenant(TENANT, () => service.deliver(row));

    const rows = await deliveries(endpointId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PENDING');
    expect(received).toHaveLength(0);
  });

  it('sends a signed delivery the receiver can verify, and marks it delivered', async () => {
    const service = build();
    const endpointId = await endpoint();
    const row = await event();
    await withTenant(TENANT, () => service.deliver(row));

    const summary = await service.deliverDue();
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

    expect(received).toHaveLength(1);
    const request = received[0] as SendRequest;
    expect(request.url).toBe('https://hooks.example.com/tp');
    const body = JSON.parse(request.body) as {
      id: string;
      type: string;
      data: unknown;
      replay: boolean;
    };
    expect(body.id).toBe(row.eventId);
    expect(body.type).toBe('order.filled');
    expect(body.data).toEqual({ orderId: `order-${sequence}`, volume: '0.10' });
    expect(body.replay).toBe(false);

    const now = Math.floor(Date.now() / 1000);
    expect(verify(request.headers['x-signature'], request.body, [SECRET], now, 300)).toEqual({
      ok: true,
    });
    expect(verify(request.headers['x-signature'], request.body, ['wrong'], now, 300)).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });

    const [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('DELIVERED');
    expect(delivery?.responseStatus).toBe(200);
    expect(delivery?.attempts).toBe(1);
  });

  it('subscribes an endpoint only to the events it asked for', async () => {
    const service = build();
    const fillsOnly = await endpoint({ events: ['order.filled'] });
    const everything = await endpoint({ events: [] });

    await withTenant(TENANT, async () =>
      service.deliver(await eventInScope({ eventType: 'position.closed' })),
    );

    expect(await deliveries(fillsOnly)).toHaveLength(0);
    expect(await deliveries(everything)).toHaveLength(1);
  });

  /** The relay may hand an event over twice. The second must create nothing. */
  it('creates one delivery when the relay hands the same event over twice', async () => {
    const service = build();
    const endpointId = await endpoint();
    const row = await event();
    await withTenant(TENANT, () => service.deliver(row));
    await withTenant(TENANT, () => service.deliver(row));
    expect(await deliveries(endpointId)).toHaveLength(1);
  });

  it('retries a failed delivery on the schedule and keeps it as EXHAUSTED at the end', async () => {
    const service = build();
    const endpointId = await endpoint();
    await withTenant(TENANT, async () => service.deliver(await eventInScope()));
    answer = () => ({ kind: 'response', status: 503, body: 'down', durationMs: 5 });

    const first = await service.deliverDue();
    expect(first).toMatchObject({ claimed: 1, failed: 1 });
    let [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('FAILED');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Not due yet: nothing is claimed.
    expect((await service.deliverDue()).claimed).toBe(0);

    // Two more attempts, stepping the clock past each scheduled time.
    let clock = delivery?.nextAttemptAt as Date;
    await service.deliverDue(clock);
    [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('FAILED');
    clock = delivery?.nextAttemptAt as Date;
    const last = await service.deliverDue(clock);
    expect(last).toMatchObject({ exhausted: 1 });

    [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('EXHAUSTED');
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.lastError).toMatch(/503/);
    expect(received).toHaveLength(3);
  });

  it('does not count a redirect as delivered', async () => {
    const service = build();
    const endpointId = await endpoint();
    await withTenant(TENANT, async () => service.deliver(await eventInScope()));
    answer = () => ({ kind: 'response', status: 302, body: '', durationMs: 5 });
    await service.deliverDue();
    const [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('FAILED');
  });

  /**
   * Two exhausted deliveries in a row and the endpoint is switched off with
   * a reason — and a success in between resets the count.
   */
  it('switches an endpoint off after a streak of exhausted deliveries, with a reason', async () => {
    const service = build();
    const endpointId = await endpoint();
    answer = () => ({ kind: 'error', reason: 'ECONNREFUSED', durationMs: 1 });

    const exhaust = async () => {
      await withTenant(TENANT, async () => service.deliver(await eventInScope()));
      let clock = new Date();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await service.deliverDue(clock);
        clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
      }
    };

    await exhaust();
    let row = await withoutTenantScope('assertion', () =>
      prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } }),
    );
    expect(row.enabled).toBe(true);
    expect(row.consecutiveFailures).toBe(1);

    // A success in between resets the streak.
    answer = () => ({ kind: 'response', status: 204, body: '', durationMs: 5 });
    await withTenant(TENANT, async () => service.deliver(await eventInScope()));
    await service.deliverDue();
    row = await withoutTenantScope('assertion', () =>
      prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } }),
    );
    expect(row.consecutiveFailures).toBe(0);

    answer = () => ({ kind: 'error', reason: 'ECONNREFUSED', durationMs: 1 });
    await exhaust();
    await exhaust();
    row = await withoutTenantScope('assertion', () =>
      prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } }),
    );
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toMatch(/switched off by the platform after 2/);

    const audit = await withoutTenantScope('assertion', () =>
      prisma.auditLog.findFirst({ where: { action: 'WEBHOOK_ENDPOINT_AUTO_DISABLED' } }),
    );
    expect(audit?.resourceId).toBe(endpointId);
  });

  it('does not send to an endpoint that was switched off after the delivery was recorded', async () => {
    const service = build();
    const endpointId = await endpoint();
    await withTenant(TENANT, async () => service.deliver(await eventInScope()));
    await withoutTenantScope('fixture', () =>
      prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { enabled: false } }),
    );
    await service.deliverDue();
    expect(received).toHaveLength(0);
    const [delivery] = await deliveries(endpointId);
    expect(delivery?.status).toBe('FAILED');
    expect(delivery?.nextAttemptAt).toBeNull();
  });

  it('never records one firm’s event against another firm’s endpoint', async () => {
    const service = build();
    const otherId = await createTenant(prisma, 'other-firm');
    const mine = await endpoint();
    const theirs = await endpoint({ tenantId: otherId });

    const row = await event();
    await withTenant(TENANT, () => service.deliver(row));

    expect(await deliveries(mine)).toHaveLength(1);
    expect(await deliveries(theirs)).toHaveLength(0);
  });

  it('is what the outbox relay hands events to', async () => {
    const relay = new OutboxRelayService(
      prisma as unknown as PrismaService,
      new ConfigService({}) as never,
    );
    const service = build({}, relay);
    const endpointId = await endpoint();
    await event();

    const summary = await relay.relay();
    expect(summary.relayed).toBe(1);
    expect(await deliveries(endpointId)).toHaveLength(1);
    expect(service).toBeDefined();
  });

  it('signs with both secrets during a rotation', async () => {
    const service = build();
    const endpointId = await endpoint();
    await withoutTenantScope('fixture', () =>
      prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: {
          previousSecretSealed: box.seal('whsec_the_old_one', endpointId),
          previousSecretExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    await withTenant(TENANT, async () => service.deliver(await eventInScope()));
    await service.deliverDue();
    const request = received[0] as SendRequest;
    const now = Math.floor(Date.now() / 1000);
    expect(
      verify(request.headers['x-signature'], request.body, ['whsec_the_old_one'], now, 300),
    ).toEqual({
      ok: true,
    });
    expect(verify(request.headers['x-signature'], request.body, [SECRET], now, 300)).toEqual({
      ok: true,
    });
  });

  async function eventInScope(over: { eventType?: string } = {}): Promise<OutboxEvent> {
    return event(over);
  }
});
