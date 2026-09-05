import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  BrokerAdapterRegistry,
  mockBrokerAdapterFactory,
  type BrokerCredentials,
  type BrokerEvent,
} from '@tp/broker-sdk';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { withTenant } from '@tp/tenancy';
import { BrokerConnectionsService } from '../../src/broker-connections/broker-connections.service';
import { BrokerInboxService } from '../../src/broker-connections/broker-inbox.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { SecretBoxService } from '../../src/common/crypto/crypto.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_TENANT_ID,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const CREDENTIALS: BrokerCredentials = {
  kind: 'LOGIN_PASSWORD_SERVER',
  fields: { login: '1001', password: 'correct-horse-battery', server: 'Mock-Live' },
};

const AT = new Date('2026-09-04T10:00:00.000Z');

function event(overrides: Partial<BrokerEvent> = {}): BrokerEvent {
  return {
    externalEventId: 'EV-1',
    sequence: 1,
    at: AT,
    kind: 'ORDER_FILLED',
    externalAccountId: 'MOCK-1001',
    payload: { orderId: 'MO-1', volume: '1.00', price: '4600.00' },
    ...overrides,
  };
}

/**
 * A venue redelivers, arrives late, and arrives out of order. None of those
 * is an error, and none of them may become a second fill.
 *
 * What these tests are about is that recording is separate from acting: the
 * row is written whatever the platform later decides, it is written exactly
 * once per `(connection, external id)`, it keeps the venue's own ordering,
 * and it cannot be edited or deleted afterwards — because a discrepancy
 * argued about a week later is settled by what the venue actually said.
 */
suite('Broker inbox (integration)', () => {
  let prisma: PrismaClient;
  let inbox: BrokerInboxService;
  let connections: BrokerConnectionsService;
  let connectionId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const prismaService = prisma as unknown as PrismaService;
    const secrets = new SecretBox(
      parseEncryptionKeys(generateEncryptionKey('test')),
    ) as unknown as SecretBoxService;
    const registry = new BrokerAdapterRegistry();
    registry.register(mockBrokerAdapterFactory);
    connections = new BrokerConnectionsService(
      prismaService,
      new AuditService(prismaService),
      secrets,
      registry,
    );
    inbox = new BrokerInboxService(prismaService);

    actorId = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: 'ops@test.local',
          passwordHash: 'not-a-real-hash',
          displayName: 'Ops',
          role: 'ADMIN',
        },
      })
    ).id;
    const connection = await connections.create(actorId, {
      name: 'Mock venue',
      adapterKind: 'MOCK',
    });
    connectionId = connection.id;
    await connections.setCredentials(actorId, connectionId, CREDENTIALS);
  });

  it('records what arrived, exactly as it arrived', async () => {
    const recorded = await inbox.record(connectionId, event());
    expect(recorded.fresh).toBe(true);

    const row = await prisma.brokerInboundEvent.findUniqueOrThrow({
      where: { id: recorded.id },
    });
    expect(row).toMatchObject({
      externalEventId: 'EV-1',
      kind: 'ORDER_FILLED',
      externalAccountId: 'MOCK-1001',
      status: 'PENDING',
      attempts: 0,
      appliedAt: null,
    });
    expect(row.sequence).toBe(1n);
    expect(row.occurredAt.toISOString()).toBe(AT.toISOString());
    expect(row.payload).toEqual({ orderId: 'MO-1', volume: '1.00', price: '4600.00' });
  });

  it('a redelivery is the same row, not a second fill', async () => {
    const first = await inbox.record(connectionId, event());
    const again = await inbox.record(
      connectionId,
      // The venue resends with a different payload for the same occurrence:
      // the id is what identifies it, and the first payload is what is kept.
      event({ payload: { orderId: 'MO-1', volume: '9.99', price: '1.00' } }),
    );
    expect(again).toEqual({ id: first.id, fresh: false });
    expect(await prisma.brokerInboundEvent.count()).toBe(1);
    const row = await prisma.brokerInboundEvent.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.payload).toMatchObject({ volume: '1.00' });
  });

  it('the same external id from a different connection is a different event', async () => {
    await inbox.record(connectionId, event());
    const second = await connections.create(actorId, {
      name: 'Second venue',
      adapterKind: 'MOCK',
    });
    const other = await inbox.record(second.id, event());
    expect(other.fresh).toBe(true);
    expect(await prisma.brokerInboundEvent.count()).toBe(2);
  });

  it('records a batch in the venue’s own order, however it arrived, and counts the duplicates', async () => {
    const events = [
      event({ externalEventId: 'EV-3', sequence: 3 }),
      event({ externalEventId: 'EV-1', sequence: 1 }),
      event({ externalEventId: 'EV-2', sequence: 2 }),
    ];
    const first = await inbox.recordAll(connectionId, events);
    expect(first).toEqual({ recorded: 3, duplicates: 0 });

    const rows = await prisma.brokerInboundEvent.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(rows.map((row) => row.externalEventId)).toEqual(['EV-1', 'EV-2', 'EV-3']);

    // The venue redelivers the whole window after a reconnect. Nothing doubles.
    const replayed = await inbox.recordAll(connectionId, [
      ...events,
      event({ externalEventId: 'EV-4', sequence: 4 }),
    ]);
    expect(replayed).toEqual({ recorded: 1, duplicates: 3 });
    expect(await prisma.brokerInboundEvent.count()).toBe(4);
  });

  it('orders by the venue’s sequence, falling back to its clock when it gives none', async () => {
    await inbox.recordAll(connectionId, [
      event({ externalEventId: 'B', sequence: null, at: new Date(AT.getTime() + 2_000) }),
      event({ externalEventId: 'A', sequence: null, at: AT }),
    ]);
    const pending = await inbox.pending(connectionId);
    expect(pending.events.map((row) => row.externalEventId)).toEqual(['A', 'B']);
    // A bigint does not survive JSON; the ordering label travels as a string.
    expect(pending.events[0]?.sequence).toBe(null);
  });

  it('moves only the handling status: applied, skipped, failed, replayed', async () => {
    const applied = await inbox.record(connectionId, event({ externalEventId: 'A' }));
    const skipped = await inbox.record(connectionId, event({ externalEventId: 'B', sequence: 2 }));
    const failed = await inbox.record(connectionId, event({ externalEventId: 'C', sequence: 3 }));

    await inbox.markApplied(applied.id);
    await inbox.markSkipped(skipped.id, 'this build does not handle BALANCE_CHANGED');
    await inbox.markFailed(failed.id, 'no account is mapped to MOCK-1001');

    const rows = new Map(
      (await prisma.brokerInboundEvent.findMany()).map((row) => [row.externalEventId, row]),
    );
    expect(rows.get('A')).toMatchObject({ status: 'APPLIED', attempts: 1 });
    expect(rows.get('A')?.appliedAt).not.toBe(null);
    expect(rows.get('B')).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'this build does not handle BALANCE_CHANGED',
    });
    expect(rows.get('C')).toMatchObject({
      status: 'FAILED',
      lastError: 'no account is mapped to MOCK-1001',
    });

    // Nothing pending but what has not been decided.
    expect((await inbox.pending(connectionId)).events).toHaveLength(0);

    // A failure is put back for corrected code, and keeps its attempt count.
    await inbox.replay(failed.id);
    const back = await prisma.brokerInboundEvent.findUniqueOrThrow({ where: { id: failed.id } });
    expect(back).toMatchObject({ status: 'PENDING', lastError: null, attempts: 1 });
  });

  it('an applied event is not applied twice by a second pass', async () => {
    const recorded = await inbox.record(connectionId, event());
    await inbox.markApplied(recorded.id);
    const firstAppliedAt = (
      await prisma.brokerInboundEvent.findUniqueOrThrow({ where: { id: recorded.id } })
    ).appliedAt;

    await inbox.markApplied(recorded.id);
    const row = await prisma.brokerInboundEvent.findUniqueOrThrow({ where: { id: recorded.id } });
    // Still one application: the guard is `status: PENDING`, not a flag we set.
    expect(row.attempts).toBe(1);
    expect(row.appliedAt?.toISOString()).toBe(firstAppliedAt?.toISOString());
  });

  it('is evidence: the payload cannot be rewritten and the row cannot be deleted', async () => {
    const recorded = await inbox.record(connectionId, event());
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE broker_inbound_events SET payload = '{"volume":"9.99"}'::jsonb WHERE id = $1`,
        recorded.id,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM broker_inbound_events WHERE id = $1`, recorded.id),
    ).rejects.toThrow();
    const row = await prisma.brokerInboundEvent.findUniqueOrThrow({ where: { id: recorded.id } });
    expect(row.payload).toMatchObject({ volume: '1.00' });
  });

  it('will not show one firm what another firm’s venue sent', async () => {
    await inbox.record(connectionId, event());
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect((await inbox.list(connectionId)).events).toEqual([]);
      expect((await inbox.pending(connectionId)).events).toEqual([]);
    });
  });
});
