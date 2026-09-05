import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  BrokerAdapterRegistry,
  MockBrokerAdapter,
  mockBrokerAdapterFactory,
  type BrokerCredentials,
} from '@tp/broker-sdk';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { TradingErrorCode } from '@tp/shared-types';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { BrokerConnectionsService } from '../../src/broker-connections/broker-connections.service';
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

/**
 * Connections are rows with sealed credentials beside them. What these tests
 * are about is the one promise that matters: a credential's value goes in and
 * never comes out — not from a route, not from an audit row, not from an
 * error message — and the row that holds it cannot be altered or deleted.
 */
suite('Broker connections (integration)', () => {
  let prisma: PrismaClient;
  let service: BrokerConnectionsService;
  let registry: BrokerAdapterRegistry;
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
    registry = new BrokerAdapterRegistry();
    service = new BrokerConnectionsService(
      prismaService,
      new AuditService(prismaService),
      secrets,
      registry,
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

  const aConnection = () => service.create(actorId, { name: 'Mock venue', adapterKind: 'MOCK' });

  it('offers only the connectors this build has, and refuses one it does not', async () => {
    expect(service.connectors().map((row) => row.kind)).toEqual(['MOCK']);
    await expect(
      service.create(actorId, { name: 'Acme', adapterKind: 'ACME' }),
    ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    expect(await prisma.brokerConnection.count()).toBe(0);
  });

  it('creates a connection, and refuses a second of the same name', async () => {
    const created = await aConnection();
    expect(created).toMatchObject({
      name: 'Mock venue',
      adapterKind: 'MOCK',
      status: 'UNKNOWN',
      enabled: true,
    });
    expect(created.credentials).toEqual([]);
    await expect(aConnection()).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'broker_connection.created' },
    });
    expect(trail.actorId).toBe(actorId);
  });

  it('seals the credentials, shows only metadata, and puts no secret anywhere readable', async () => {
    const connection = await aConnection();
    const withCredentials = await service.setCredentials(actorId, connection.id, CREDENTIALS);

    const [credential] = withCredentials.credentials;
    expect(credential).toMatchObject({
      kind: 'LOGIN_PASSWORD_SERVER',
      visible: { login: '1001', server: 'Mock-Live' },
      revokedAt: null,
    });
    expect(credential?.fingerprint).toHaveLength(16);
    // Nothing the service returns carries the password, at any depth.
    expect(JSON.stringify(withCredentials)).not.toContain('correct-horse-battery');
    expect(JSON.stringify(await service.list())).not.toContain('correct-horse-battery');
    expect(JSON.stringify(await service.get(connection.id))).not.toContain('correct-horse-battery');

    // Nor does the audit trail.
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'broker_connection.credentials_set' },
    });
    expect(JSON.stringify(trail.after)).not.toContain('correct-horse-battery');
    expect(trail.after).toMatchObject({ fingerprint: credential?.fingerprint });

    // At rest it is a sealed blob, not the value.
    const row = await prisma.brokerCredential.findFirstOrThrow();
    expect(row.sealed).not.toContain('correct-horse-battery');
    expect(row.sealed.length).toBeGreaterThan(40);
  });

  it('rotating revokes the old one and keeps it: who used what, when, survives', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const rotated = await service.setCredentials(actorId, connection.id, {
      ...CREDENTIALS,
      fields: { ...CREDENTIALS.fields, password: 'a-different-passphrase' },
    });
    expect(rotated.credentials).toHaveLength(2);
    const live = rotated.credentials.filter((row) => row.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.fingerprint).not.toBe(rotated.credentials[1]?.fingerprint);
    // A rotation resets the verdict: the old one described the old session.
    expect(rotated.status).toBe('UNKNOWN');
  });

  it('refuses credentials the connector did not ask for, and demands the ones it did', async () => {
    const connection = await aConnection();
    await expect(
      service.setCredentials(actorId, connection.id, {
        kind: 'API_TOKEN',
        fields: { login: '1', password: 'x', server: 's', extra: 'nope' },
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    await expect(
      service.setCredentials(actorId, connection.id, {
        kind: 'LOGIN_PASSWORD_SERVER',
        fields: { login: '1' },
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    expect(await prisma.brokerCredential.count()).toBe(0);
  });

  it('tests a connection, records what the venue said it can do, and audits it', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const result = await service.test(actorId, connection.id);

    expect(result.status).toBe('CONNECTED');
    expect(result.capabilities).toMatchObject({
      supportsMarketOrders: true,
      supportsStopLimitOrders: false,
    });
    const stored = await service.get(connection.id);
    expect(stored.status).toBe('CONNECTED');
    expect(stored.capabilities).toMatchObject({ supportsHedging: true });
    expect(stored.lastHeartbeatAt).not.toBe(null);
    expect(stored.credentials[0]?.lastUsedAt).not.toBe(null);
    expect(await prisma.auditLog.count({ where: { action: 'broker_connection.tested' } })).toBe(1);
  });

  it('records a refusal as a state, never as an exception the caller must parse, and never leaks the secret', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, {
      ...CREDENTIALS,
      fields: { ...CREDENTIALS.fields, password: 'wrong' },
    });
    const result = await service.test(actorId, connection.id);
    expect(result).toMatchObject({ status: 'AUTH_FAILED', capabilities: null });
    expect(result.failure?.code).toBe('AUTH_FAILED');

    const stored = await service.get(connection.id);
    expect(stored.status).toBe('AUTH_FAILED');
    expect(stored.lastError).toContain('AUTH_FAILED');
    // The breaker is open: retrying the same rejected credentials cannot help.
    expect(stored.circuitOpenUntil).not.toBe(null);
    await expect(service.test(actorId, connection.id)).rejects.toMatchObject({
      code: TradingErrorCode.RATE_LIMITED,
    });
  });

  it('refuses to use a disabled connection, or one with no credentials', async () => {
    const connection = await aConnection();
    await expect(service.test(actorId, connection.id)).rejects.toMatchObject({
      code: TradingErrorCode.VALIDATION_FAILED,
    });
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const disabled = await service.setEnabled(actorId, connection.id, false, 'venue maintenance');
    expect(disabled.enabled).toBe(false);
    await expect(
      service.withAdapter(connection.id, async (adapter) => adapter.listInstruments()),
    ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
    expect(await prisma.auditLog.count({ where: { action: 'broker_connection.disabled' } })).toBe(
      1,
    );
  });

  it('opens the credential only inside withAdapter, and strips it from anything thrown out', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);

    const instruments = await service.withAdapter(connection.id, async (adapter) => {
      expect(adapter).toBeInstanceOf(MockBrokerAdapter);
      return adapter.listInstruments();
    });
    expect(instruments.length).toBeGreaterThan(0);

    // A connector that puts a credential in a message: the value never travels.
    const thrown = await service
      .withAdapter(connection.id, async () => {
        throw new Error('the venue rejected login 1001 with correct-horse-battery');
      })
      .catch((error: unknown) => error as Error);
    expect(thrown.message).not.toContain('correct-horse-battery');
    expect(thrown.message).toContain('[redacted]');
  });

  it('is one firm’s: another tenant sees none of it, and cannot open it', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const other = await createTenant(prisma, 'other-firm');

    await withTenant({ tenantId: other, slug: 'other-firm' }, async () => {
      expect(await service.list()).toEqual([]);
      await expect(service.get(connection.id)).rejects.toMatchObject({
        code: TradingErrorCode.RESOURCE_NOT_FOUND,
      });
      await expect(
        service.withAdapter(connection.id, async (adapter) => adapter.listInstruments()),
      ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
    });
  });

  /**
   * The guard the nested `include` carries, and why it is not redundant.
   *
   * The tenancy extension narrows a query's own `where`; it does not reach
   * into a relation's. So a credential row carrying another firm's tenant id
   * would ride out on this connection's `include` unless the relation names
   * the tenant itself. Nothing should ever file a row that way — which is
   * exactly why, if something does, it must not be read as this firm's.
   */
  it('will not show a credential filed under another firm, even on its own connection', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const other = await createTenant(prisma, 'other-firm');
    const mine = await prisma.brokerCredential.findFirstOrThrow();

    // A misfiled row: right connection, wrong firm.
    await withoutTenantScope('the test files a row the application never would', () =>
      prisma.brokerCredential.create({
        data: {
          tenant: { connect: { id: other } },
          connection: { connect: { id: connection.id } },
          kind: mine.kind,
          sealed: mine.sealed,
          fingerprint: 'ffffffffffffffff',
          visible: {},
          createdBy: { connect: { id: actorId } },
        },
      }),
    );

    const view = await service.get(connection.id);
    expect(view.credentials.map((row) => row.fingerprint)).toEqual([mine.fingerprint]);
    const [listed] = await service.list();
    expect(listed?.credentials.map((row) => row.fingerprint)).toEqual([mine.fingerprint]);
  });

  it('will not let a sealed credential be altered, re-pointed or deleted', async () => {
    const connection = await aConnection();
    await service.setCredentials(actorId, connection.id, CREDENTIALS);
    const row = await prisma.brokerCredential.findFirstOrThrow();

    for (const statement of [
      `UPDATE broker_credentials SET sealed = 'tampered' WHERE id = '${row.id}'`,
      `UPDATE broker_credentials SET connection_id = '${DEFAULT_TENANT_ID}' WHERE id = '${row.id}'`,
      `UPDATE broker_credentials SET fingerprint = 'aaaaaaaaaaaaaaaa' WHERE id = '${row.id}'`,
      `DELETE FROM broker_credentials WHERE id = '${row.id}'`,
    ]) {
      await expect(prisma.$executeRawUnsafe(statement)).rejects.toThrow(
        /sealed as|never deleted|violates/,
      );
    }
    const after = await prisma.brokerCredential.findFirstOrThrow();
    expect(after.sealed).toBe(row.sealed);
  });

  it('registers a real connector only with the documentation it was written against', () => {
    expect(() =>
      registry.register({ ...mockBrokerAdapterFactory, kind: 'ACME', documentation: '' }),
    ).toThrow(/names no documentation/);
  });
});
