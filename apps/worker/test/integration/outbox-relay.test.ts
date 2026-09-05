import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { OutboxEvent, PrismaClient } from '@prisma/client';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import {
  OutboxRelayService,
  backoffMs,
  type OutboxDestination,
} from '../../src/jobs/outbox-relay.service';
import type { PrismaService } from '../../src/prisma.service';
import type { WorkerEnv } from '../../src/env';
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
 * The relay's whole job is to survive crashing at the wrong moment.
 *
 * A row exists because a change committed; delivery is a separate act that
 * can fail, and the interesting question is what the relay does then. What
 * these tests pin: a failure is kept and retried with a widening backoff held
 * in the database (so a restart cannot lose it), a row that has exhausted its
 * attempts is ABANDONED rather than deleted, and one firm's undeliverable
 * event never stops another firm's from going out.
 */
suite('Outbox relay (integration)', () => {
  let prisma: PrismaClient;
  let relay: OutboxRelayService;
  let accountId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    relay = buildRelay();
    accountId = (await createAccount(prisma, { balance: '1000' })).accountId;
  });

  function buildRelay(env: Partial<WorkerEnv> = {}): OutboxRelayService {
    return new OutboxRelayService(
      prisma as unknown as PrismaService,
      new ConfigService(env) as unknown as ConfigService<WorkerEnv, true>,
    );
  }

  let sequence = 0;
  async function pending(
    overrides: { tenantId?: string; accountId?: string; occurredAt?: Date } = {},
  ): Promise<OutboxEvent> {
    sequence += 1;
    return withoutTenantScope('test fixture writes rows for several firms', () =>
      prisma.outboxEvent.create({
        data: {
          tenantId: overrides.tenantId ?? DEFAULT_TENANT_ID,
          eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          eventType: 'order.filled',
          aggregateType: 'order',
          aggregateId: `order-${sequence}`,
          accountId: overrides.accountId ?? accountId,
          payload: { orderId: `order-${sequence}` },
          ...(overrides.occurredAt === undefined ? {} : { occurredAt: overrides.occurredAt }),
        },
      }),
    );
  }

  /** A destination that records what it was handed, and can be told to fail. */
  function destination(name = 'test'): OutboxDestination & {
    delivered: string[];
    failWith: string | null;
  } {
    return {
      name,
      delivered: [] as string[],
      failWith: null as string | null,
      async deliver(event: OutboxEvent) {
        if (this.failWith !== null) throw new Error(this.failWith);
        this.delivered.push(event.eventId);
      },
    };
  }

  it('relays what is due, in the order things happened, and marks each relayed', async () => {
    const later = await pending({ occurredAt: new Date('2026-09-04T10:00:02.000Z') });
    const earlier = await pending({ occurredAt: new Date('2026-09-04T10:00:01.000Z') });
    const sink = destination();
    relay.register(sink);

    const summary = await relay.relay();
    expect(summary).toEqual({ claimed: 2, relayed: 2, failed: 0, abandoned: 0 });
    expect(sink.delivered).toEqual([earlier.eventId, later.eventId]);

    const rows = await withoutTenantScope('assertion', () => prisma.outboxEvent.findMany());
    expect(rows.every((row) => row.status === 'RELAYED' && row.relayedAt !== null)).toBe(true);
    // Relayed once: a second pass claims nothing.
    expect(await relay.relay()).toEqual({ claimed: 0, relayed: 0, failed: 0, abandoned: 0 });
  });

  it('with no destination registered, the outbox stays a truthful record of what went out', async () => {
    await pending();
    const summary = await relay.relay();
    expect(summary).toMatchObject({ claimed: 1, relayed: 1 });
    const row = await withoutTenantScope('assertion', () => prisma.outboxEvent.findFirstOrThrow());
    expect(row.status).toBe('RELAYED');
    expect(row.lastError).toBe(null);
  });

  it('keeps a failure, records why, and schedules the next attempt with a widening backoff', async () => {
    const event = await pending();
    const sink = destination('webhook');
    sink.failWith = 'the endpoint returned 503';
    relay.register(sink);

    const now = new Date('2026-09-04T12:00:00.000Z');
    expect(await relay.relay(now)).toEqual({ claimed: 1, relayed: 0, failed: 1, abandoned: 0 });

    const after = await withoutTenantScope('assertion', () =>
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
    );
    expect(after).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(after.lastError).toContain('webhook: the endpoint returned 503');
    expect(after.nextAttemptAt?.getTime()).toBe(now.getTime() + backoffMs(1));

    // Not due yet: the backoff is held in the row, so a restart still honours it.
    expect(await relay.relay(now)).toMatchObject({ claimed: 0 });
    const later = new Date(now.getTime() + backoffMs(1));
    sink.failWith = null;
    expect(await relay.relay(later)).toMatchObject({ claimed: 1, relayed: 1 });
    expect(sink.delivered).toEqual([event.eventId]);
  });

  it('abandons rather than deletes an event that cannot be delivered, and says so', async () => {
    const event = await pending();
    relay = buildRelay({ OUTBOX_MAX_ATTEMPTS: 2 } as Partial<WorkerEnv>);
    const sink = destination();
    sink.failWith = 'gone';
    relay.register(sink);

    let now = new Date('2026-09-04T12:00:00.000Z');
    expect(await relay.relay(now)).toMatchObject({ failed: 1 });
    now = new Date(now.getTime() + backoffMs(1));
    expect(await relay.relay(now)).toMatchObject({ abandoned: 1 });

    const after = await withoutTenantScope('assertion', () =>
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }),
    );
    // A financial event nobody could be told about is a thing a person must
    // see, so it is kept, with its reason and its attempt count intact.
    expect(after).toMatchObject({ status: 'ABANDONED', attempts: 2, nextAttemptAt: null });
    expect(after.lastError).toContain('gone');
    expect(after.payload).toMatchObject({ orderId: after.aggregateId });
    // And it is not picked up again.
    expect(await relay.relay(new Date(now.getTime() + 86_400_000))).toMatchObject({ claimed: 0 });
  });

  it('relays every firm’s events, each inside its own scope', async () => {
    const otherTenantId = await createTenant(prisma, 'other-firm');
    const otherAccount = await withTenant(
      { tenantId: otherTenantId, slug: 'other-firm', kind: 'BROKER' },
      () => createAccount(prisma, { tenantId: otherTenantId, email: 'other@test.local' }),
    );
    const mine = await pending();
    const theirs = await pending({ tenantId: otherTenantId, accountId: otherAccount.accountId });

    const seen: string[] = [];
    relay.register({
      name: 'scope-check',
      deliver: async (event) => {
        // Inside delivery the relay stands in the event's own tenant, so a
        // destination that reads the database reads the right firm's rows.
        const rows = await prisma.outboxEvent.findMany();
        expect(rows.every((row) => row.tenantId === event.tenantId)).toBe(true);
        seen.push(event.eventId);
      },
    });

    expect(await relay.relay()).toMatchObject({ claimed: 2, relayed: 2 });
    expect(seen.sort()).toEqual([mine.eventId, theirs.eventId].sort());
  });

  it('one firm’s failing destination does not stop another firm’s events', async () => {
    const otherTenantId = await createTenant(prisma, 'other-firm');
    const otherAccount = await withTenant(
      { tenantId: otherTenantId, slug: 'other-firm', kind: 'BROKER' },
      () => createAccount(prisma, { tenantId: otherTenantId, email: 'other@test.local' }),
    );
    const failing = await pending();
    const fine = await pending({ tenantId: otherTenantId, accountId: otherAccount.accountId });

    const delivered: string[] = [];
    relay.register({
      name: 'picky',
      deliver: async (event) => {
        if (event.tenantId === DEFAULT_TENANT_ID) throw new Error('refused');
        delivered.push(event.eventId);
      },
    });

    expect(await relay.relay()).toEqual({ claimed: 2, relayed: 1, failed: 1, abandoned: 0 });
    expect(delivered).toEqual([fine.eventId]);
    const rows = new Map(
      (await withoutTenantScope('assertion', () => prisma.outboxEvent.findMany())).map((row) => [
        row.id,
        row,
      ]),
    );
    expect(rows.get(failing.id)?.status).toBe('PENDING');
    expect(rows.get(fine.id)?.status).toBe('RELAYED');
  });

  it('leaves a suspended firm’s events alone rather than delivering on its behalf', async () => {
    await pending();
    await withoutTenantScope('test fixture', () =>
      prisma.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: 'SUSPENDED' } }),
    );
    const sink = destination();
    relay.register(sink);

    expect(await relay.relay()).toEqual({ claimed: 1, relayed: 0, failed: 0, abandoned: 0 });
    expect(sink.delivered).toEqual([]);
    const row = await withoutTenantScope('assertion', () => prisma.outboxEvent.findFirstOrThrow());
    // Untouched, not failed: a suspension is not a delivery failure.
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
  });

  it('widens the backoff and then stops widening it', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    // Capped, so a long-dead endpoint is retried hourly-ish rather than never.
    expect(backoffMs(30)).toBe(15 * 60_000);
  });
});
