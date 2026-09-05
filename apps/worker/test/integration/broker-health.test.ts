import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import {
  BrokerAdapterRegistry,
  MockBrokerAdapter,
  mockBrokerAdapterFactory,
  serialiseCredentials,
  type BrokerCredentials,
} from '@tp/broker-sdk';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { BrokerHealthService } from '../../src/jobs/broker-health.service';
import type { PrismaService } from '../../src/prisma.service';
import type { WorkerEnv } from '../../src/env';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
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

/**
 * The sweep asks every enabled connection how it is. What these tests pin is
 * what it does with the answer — and what it refuses to do: hammer a venue
 * that has just refused it, stop the sweep because one firm's connection
 * failed, or call any of it a trader's doing.
 */
suite('Broker health sweep (integration)', () => {
  let prisma: PrismaClient;
  let secrets: SecretBox;
  let registry: BrokerAdapterRegistry;
  let service: BrokerHealthService;
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
    secrets = new SecretBox(parseEncryptionKeys(generateEncryptionKey('test')));
    registry = new BrokerAdapterRegistry();
    service = new BrokerHealthService(
      prisma as unknown as PrismaService,
      registry,
      new ConfigService({}) as unknown as ConfigService<WorkerEnv, true>,
      secrets,
    );
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
  });

  async function aConnection(
    options: {
      tenantId?: string;
      name?: string;
      credentials?: BrokerCredentials | null;
      enabled?: boolean;
      adapterKind?: string;
    } = {},
  ): Promise<string> {
    const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
    const connection = await prisma.brokerConnection.create({
      data: {
        tenantId,
        name: options.name ?? `venue-${Math.random()}`,
        adapterKind: options.adapterKind ?? 'MOCK',
        enabled: options.enabled ?? true,
        createdById: actorId,
      },
    });
    const credentials = options.credentials === undefined ? CREDENTIALS : options.credentials;
    if (credentials !== null) {
      await prisma.brokerCredential.create({
        data: {
          tenantId,
          connectionId: connection.id,
          kind: credentials.kind,
          sealed: secrets.seal(serialiseCredentials(credentials), connection.id),
          fingerprint: 'f'.repeat(16),
          createdById: actorId,
        },
      });
    }
    return connection.id;
  }

  it('records a healthy connection with its capabilities and a heartbeat', async () => {
    const id = await aConnection();
    const summary = await service.sweep();
    expect(summary).toMatchObject({ checked: 1, connected: 1, failing: 0, backingOff: 0 });

    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CONNECTED');
    expect(row.lastHeartbeatAt).not.toBe(null);
    expect(row.statusChangedAt).not.toBe(null);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.capabilities).toMatchObject({ supportsMarketOrders: true });
    const credential = await prisma.brokerCredential.findFirstOrThrow();
    expect(credential.lastUsedAt).not.toBe(null);
  });

  it('records a refusal, opens the breaker, and then skips rather than hammering', async () => {
    const id = await aConnection({
      credentials: { ...CREDENTIALS, fields: { ...CREDENTIALS.fields, password: 'wrong' } },
    });
    const first = await service.sweep();
    expect(first).toMatchObject({ checked: 1, failing: 1 });
    const afterFirst = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    expect(afterFirst.status).toBe('AUTH_FAILED');
    expect(afterFirst.circuitOpenUntil).not.toBe(null);
    expect(afterFirst.lastError).toContain('AUTH_FAILED');

    const second = await service.sweep();
    expect(second).toMatchObject({ checked: 0, backingOff: 1 });
    const afterSecond = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    // Untouched: the same failure count, the same window.
    expect(afterSecond.consecutiveFailures).toBe(afterFirst.consecutiveFailures);
    expect(afterSecond.circuitOpenUntil).toEqual(afterFirst.circuitOpenUntil);
  });

  it('never puts a credential value in a stored error, however the failure arrived', async () => {
    const id = await aConnection({ name: 'leaky' });
    registry.register({
      ...mockBrokerAdapterFactory,
      kind: 'LEAKY',
      documentation: 'a connector that leaks, to prove it cannot',
      create: () => {
        const adapter = new MockBrokerAdapter({ latencyMs: 0 });
        return {
          ...adapter,
          kind: 'LEAKY',
          connect: async () => {
            throw new Error(`login failed for 1001 / correct-horse-battery at Mock-Live`);
          },
          disconnect: async () => undefined,
          getCapabilities: () => adapter.getCapabilities(),
          healthcheck: () => adapter.healthcheck(),
        } as unknown as ReturnType<typeof mockBrokerAdapterFactory.create>;
      },
    });
    await prisma.brokerConnection.update({ where: { id }, data: { adapterKind: 'LEAKY' } });

    await service.sweep();
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    expect(row.lastError).not.toContain('correct-horse-battery');
    expect(row.lastError).toContain('[redacted]');
  });

  it('skips a disabled connection, and reports one with no credentials as unusable', async () => {
    await aConnection({ name: 'off', enabled: false });
    const bare = await aConnection({ name: 'bare', credentials: null });
    const summary = await service.sweep();
    expect(summary.checked).toBe(1);
    const off = await prisma.brokerConnection.findFirstOrThrow({ where: { name: 'off' } });
    expect(off.status).toBe('UNKNOWN');
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: bare } });
    expect(row.status).toBe('DISCONNECTED');
    expect(row.lastError).toContain('no credentials');
  });

  it('refuses a connector this build does not have, rather than crashing the sweep', async () => {
    const missing = await aConnection({ name: 'gone', adapterKind: 'MOCK' });
    await prisma.brokerConnection.update({ where: { id: missing }, data: { adapterKind: 'ACME' } });
    const healthy = await aConnection({ name: 'fine' });
    const summary = await service.sweep();
    expect(summary).toMatchObject({ checked: 2, connected: 1, failing: 1 });
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: missing } });
    expect(row.lastError).toContain('no connector of kind ACME');
    expect(
      (await prisma.brokerConnection.findUniqueOrThrow({ where: { id: healthy } })).status,
    ).toBe('CONNECTED');
  });

  it('sweeps every firm, each inside its own tenant, and skips a suspended one', async () => {
    const mine = await aConnection({ name: 'mine' });
    const other = await createTenant(prisma, 'other-firm');
    const theirs = await withTenant({ tenantId: other, slug: 'other-firm' }, async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: other,
          email: 'ops@other.test',
          passwordHash: 'x',
          displayName: 'Other Ops',
          role: 'ADMIN',
        },
      });
      const connection = await prisma.brokerConnection.create({
        data: { tenantId: other, name: 'theirs', adapterKind: 'MOCK', createdById: user.id },
      });
      await prisma.brokerCredential.create({
        data: {
          tenantId: other,
          connectionId: connection.id,
          kind: CREDENTIALS.kind,
          sealed: secrets.seal(serialiseCredentials(CREDENTIALS), connection.id),
          fingerprint: 'f'.repeat(16),
          createdById: user.id,
        },
      });
      return connection.id;
    });

    expect(await service.sweep()).toMatchObject({ checked: 2, connected: 2 });
    /**
     * Both were checked, each under its own tenant — and reading them back
     * takes a deliberate crossing, because from inside one firm the other's
     * connection is not there at all. That refusal is the isolation working.
     */
    expect(
      await prisma.brokerConnection.findMany({ where: { id: { in: [mine, theirs] } } }),
    ).toHaveLength(1);
    const rows = await withoutTenantScope('the test is checking both firms were swept', () =>
      prisma.brokerConnection.findMany({ where: { id: { in: [mine, theirs] } } }),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.tenantId)).size).toBe(2);
    expect(rows.every((row) => row.status === 'CONNECTED')).toBe(true);

    // A suspended firm is skipped entirely, not marked failing.
    await prisma.tenant.update({ where: { id: other }, data: { status: 'SUSPENDED' } });
    expect(await service.sweep()).toMatchObject({ checked: 1 });
  });

  it('will not use a credential filed under another firm, even for the right connection', async () => {
    /**
     * The sweep discovers across tenants and then works *inside* each one.
     * Without that second half a connection could be opened with whatever
     * credential row happened to name it, whoever it belonged to. Here the
     * only credential for this connection is filed under another firm; the
     * scope must make it invisible, and the connection unusable.
     */
    const other = await createTenant(prisma, 'other-firm');
    const connection = await prisma.brokerConnection.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        name: 'crossed',
        adapterKind: 'MOCK',
        createdById: actorId,
      },
    });
    await withoutTenantScope('the test is planting a misfiled row on purpose', () =>
      prisma.brokerCredential.create({
        data: {
          tenantId: other,
          connectionId: connection.id,
          kind: CREDENTIALS.kind,
          sealed: secrets.seal(serialiseCredentials(CREDENTIALS), connection.id),
          fingerprint: 'f'.repeat(16),
          createdById: actorId,
        },
      }),
    );

    const summary = await service.sweep();
    expect(summary.checked).toBe(1);
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe('DISCONNECTED');
    expect(row.lastError).toContain('no credentials');
  });

  it('says nothing about traders: a venue being down is a fact about the venue', async () => {
    await aConnection({
      credentials: { ...CREDENTIALS, fields: { ...CREDENTIALS.fields, password: 'wrong' } },
    });
    await service.sweep();
    const row = await prisma.brokerConnection.findFirstOrThrow();
    expect(/breach|violat|trader/i.test(row.lastError ?? '')).toBe(false);
    // And nothing was written against any account.
    expect(await prisma.riskEvent.count()).toBe(0);
  });

  it('cannot open a credential without the keys, and says so on the connection', async () => {
    const id = await aConnection();
    // A worker configured without SECRET_ENCRYPTION_KEYS — legal, because a
    // deployment with push off and no venues does not need them.
    const noKeys = { get: () => undefined } as unknown as ConfigService<WorkerEnv, true>;
    const keyless = new BrokerHealthService(prisma as unknown as PrismaService, registry, noKeys);
    await withTenant({ tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG }, () =>
      keyless.checkOne(id),
    );
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('AUTH_FAILED');
    expect(row.lastError).toContain('cannot open sealed credentials');
  });

  it('reports a blob its keys cannot open as unusable, and does not crash the sweep', async () => {
    const id = await aConnection();
    // A different key set: what a rotated key or a restored backup looks like.
    const stranger = new BrokerHealthService(
      prisma as unknown as PrismaService,
      registry,
      new ConfigService({}) as unknown as ConfigService<WorkerEnv, true>,
      new SecretBox(parseEncryptionKeys(generateEncryptionKey('other'))),
    );
    await withTenant({ tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG }, () =>
      stranger.checkOne(id),
    );
    const row = await prisma.brokerConnection.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('AUTH_FAILED');
    expect(row.lastError).toContain('could not be opened');
  });
});
