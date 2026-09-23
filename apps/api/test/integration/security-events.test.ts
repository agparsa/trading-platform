import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withTenant } from '@tp/tenancy';
import { AuditService } from '../../src/common/audit/audit.service';
import { runInRequestScope } from '../../src/common/request-scope';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SECURITY_KINDS } from '../../src/security/security-kinds';
import { SecurityEventsService } from '../../src/security/security-events.service';
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
 * The security feed is a projection of the audit log: `AuditService` writes
 * a `security_events` row beside every audit row whose action is somebody's
 * security business. These tests drive the audit service directly, because
 * that is the one place the feed is written from — a sign-in, a minted key
 * and a suspension all arrive here the same way.
 */
suite('Security events (integration)', () => {
  let prisma: PrismaClient;
  let audit: AuditService;
  let feed: SecurityEventsService;
  let alice: string;
  let bob: string;
  let staff: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const service = prisma as unknown as PrismaService;
    audit = new AuditService(service);
    feed = new SecurityEventsService(service);
    alice = (await createAccount(prisma, { email: 'alice@test.local' })).userId;
    bob = (await createAccount(prisma, { email: 'bob@test.local' })).userId;
    staff = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: 'staff@test.local',
          passwordHash: 'not-a-real-hash',
          displayName: 'Staff',
          role: 'ADMIN',
        },
      })
    ).id;
  });

  it('writes a security event beside the audit row, with the request that caused it', async () => {
    await runInRequestScope({ requestId: 'req-1', actorId: alice }, () =>
      audit.record({
        actorId: alice,
        actorType: 'USER',
        action: 'LOGIN',
        resourceType: 'User',
        resourceId: alice,
        ipAddress: '203.0.113.9',
        userAgent: 'a browser',
        after: { password: 'must-not-appear', device: 'laptop' },
      }),
    );

    const [event] = await feed.listMine(alice);
    expect(event).toMatchObject({
      kind: 'SIGN_IN',
      severity: 'INFO',
      ipAddress: '203.0.113.9',
      userAgent: 'a browser',
      requestId: 'req-1',
      byOther: false,
    });
    // Redacted on the way in, like the audit row it came from.
    expect(JSON.stringify(event?.details)).not.toContain('must-not-appear');
    expect(event?.details).toMatchObject({ device: 'laptop' });

    const row = await prisma.securityEvent.findFirstOrThrow({ where: { userId: alice } });
    const source = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.auditLogId! } });
    expect(source.action).toBe('LOGIN');
    expect(source.requestId).toBe('req-1');
  });

  it('attributes an event to the person it concerns, not always to the actor', async () => {
    // Staff suspends Alice: Alice's feed, by somebody else.
    await audit.record({
      actorId: staff,
      actorType: 'ADMIN',
      action: 'user.suspended',
      resourceType: 'user',
      resourceId: alice,
      after: { reason: 'chargeback' },
    });
    // Bob mints a key: the resource is the key, the subject is Bob.
    await audit.record({
      actorId: bob,
      actorType: 'USER',
      action: 'api_key.minted',
      resourceType: 'ApiKey',
      resourceId: '00000000-0000-4000-8000-000000000001',
      after: { fingerprint: 'tpk_abc' },
    });

    const alices = await feed.listMine(alice);
    expect(alices).toHaveLength(1);
    expect(alices[0]).toMatchObject({ kind: 'USER_SUSPENDED', severity: 'WARNING', byOther: true });

    const bobs = await feed.listMine(bob);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({ kind: 'API_KEY_MINTED', severity: 'NOTICE', byOther: false });

    // Nobody sees anybody else's.
    expect(await feed.listMine(staff)).toHaveLength(0);
  });

  it('feeds nothing for an audit action that is not a security matter', async () => {
    await audit.record({
      actorId: alice,
      actorType: 'USER',
      action: 'order.created',
      resourceType: 'order',
      resourceId: '00000000-0000-4000-8000-000000000002',
    });
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.securityEvent.count()).toBe(0);
  });

  it('covers every kind the enum names, and names only kinds the enum has', async () => {
    const mapped = new Set(Object.values(SECURITY_KINDS).map((entry) => entry.kind));
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT unnest(enum_range(NULL::"SecurityEventKind"))::text AS value
    `;
    const enumerated = new Set(rows.map((row) => row.value));
    expect([...mapped].sort()).toEqual([...enumerated].sort());
  });

  it("gives the firm's feed to staff, filtered, and never another tenant's", async () => {
    await audit.record({
      actorId: alice,
      actorType: 'USER',
      action: 'LOGIN_FAILED',
      resourceType: 'User',
      resourceId: alice,
      ipAddress: '198.51.100.1',
    });
    await audit.record({
      actorId: bob,
      actorType: 'USER',
      action: 'LOGIN',
      resourceType: 'User',
      resourceId: bob,
      ipAddress: '198.51.100.2',
    });
    const other = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: other, slug: 'other-firm' }, async () => {
      const theirs = await createAccount(prisma, { email: 'c@other.test', tenantId: other });
      await audit.record({
        actorId: theirs.userId,
        actorType: 'USER',
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        resourceId: theirs.userId,
      });
    });

    const all = await feed.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.userEmail).sort()).toEqual(['alice@test.local', 'bob@test.local']);

    const warnings = await feed.listAll({ severity: 'WARNING' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'SIGN_IN_FAILED', userId: alice });

    expect(await feed.listAll({ ipAddress: '198.51.100.2' })).toHaveLength(1);
    expect(await feed.listAll({ kind: 'PASSWORD_CHANGED' })).toHaveLength(0);

    const summary = await feed.summary(new Date(Date.now() - 60_000));
    expect(summary.byKind).toEqual(
      expect.arrayContaining([
        { kind: 'SIGN_IN_FAILED', severity: 'WARNING', count: 1 },
        { kind: 'SIGN_IN', severity: 'INFO', count: 1 },
      ]),
    );
  });

  it('rolls the security event back with the audit row when a transaction fails', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(
          {
            actorId: alice,
            actorType: 'USER',
            action: 'PASSWORD_CHANGED',
            resourceType: 'User',
            resourceId: alice,
          },
          tx,
        );
        throw new Error('the operation this described did not happen');
      }),
    ).rejects.toThrow('did not happen');
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.securityEvent.count()).toBe(0);
  });

  /**
   * §49: the firm's own systems can be told (`security.alert`).
   *
   * The rate is the design. A webhook that fires on every successful sign-in
   * is a denial-of-service against whoever reads it, and a receiver that has
   * learned to ignore the type is worse than no receiver at all — so only the
   * severity the platform already calls WARNING, the set an attacker leaves
   * behind, reaches the outbox.
   */
  it('writes an outbox event for a WARNING, and for nothing quieter', async () => {
    await runInRequestScope({ requestId: 'req-alarm', actorId: alice }, () =>
      audit.record({
        actorId: alice,
        actorType: 'USER',
        action: 'LOGIN',
        resourceType: 'User',
        resourceId: alice,
        ipAddress: '203.0.113.9',
      }),
    );
    await audit.record({
      actorId: bob,
      actorType: 'USER',
      action: 'api_key.minted',
      resourceType: 'ApiKey',
      resourceId: '00000000-0000-4000-8000-000000000001',
    });
    // INFO and NOTICE are in the feed and out of the outbox.
    expect(await prisma.securityEvent.count()).toBe(2);
    expect(await prisma.outboxEvent.count()).toBe(0);

    await runInRequestScope({ requestId: 'req-2fa-off', actorId: staff }, () =>
      audit.record({
        actorId: staff,
        actorType: 'ADMIN',
        action: 'TWO_FACTOR_DISABLED',
        resourceType: 'User',
        resourceId: alice,
        ipAddress: '198.51.100.7',
        userAgent: 'a browser',
        after: { totpSecret: 'must-not-appear', by: 'support' },
      }),
    );

    const [event] = await prisma.outboxEvent.findMany();
    expect(event?.eventType).toBe('security.alert');
    expect(event?.aggregateType).toBe('security_event');
    expect(event?.correlationId).toBe('req-2fa-off');
    // A security event is about a person: an account filter must not eat it.
    expect(event?.accountId).toBeNull();

    const payload = event?.payload as Record<string, unknown>;
    expect(payload['kind']).toBe('TWO_FACTOR_DISABLED');
    expect(payload['severity']).toBe('WARNING');
    expect(payload['action']).toBe('TWO_FACTOR_DISABLED');
    expect(payload['userId']).toBe(alice);
    expect(payload['actorId']).toBe(staff);
    expect(payload['ipAddress']).toBe('198.51.100.7');

    // The event points at the row it came from, both ways.
    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { kind: 'TWO_FACTOR_DISABLED' },
    });
    expect(payload['securityEventId']).toBe(row.id);
    expect(event?.aggregateId).toBe(row.id);
    expect(payload['auditLogId']).toBe(row.auditLogId);

    // Redacted on the way in, and still redacted on the way out of the firm.
    expect(JSON.stringify(payload)).not.toContain('must-not-appear');
    expect(payload['details']).toMatchObject({ by: 'support' });
  });

  it('does not write a security event without the alert it owes', async () => {
    /**
     * The audit row, the feed row and the outbox row are written on one
     * client, so a caller's transaction takes all three or none. Without that,
     * an alert could be dropped while the feed said the event happened — and
     * the feed is append-only, so nothing would ever send it.
     */
    const service = prisma as unknown as PrismaService;
    await expect(
      service.$transaction(async (tx) => {
        await new AuditService(service).record(
          {
            actorId: staff,
            actorType: 'ADMIN',
            action: 'TWO_FACTOR_DISABLED',
            resourceType: 'User',
            resourceId: alice,
          },
          tx,
        );
        throw new Error('the operation failed after its audit');
      }),
    ).rejects.toThrow('the operation failed after its audit');

    expect(await prisma.securityEvent.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('is append-only at the database: no update, no delete, no truncate', async () => {
    await audit.record({
      actorId: alice,
      actorType: 'USER',
      action: 'TWO_FACTOR_DISABLED',
      resourceType: 'User',
      resourceId: alice,
    });
    const row = await prisma.securityEvent.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE security_events SET kind = 'SIGN_IN' WHERE id = '${row.id}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM security_events WHERE id = '${row.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE security_events`)).rejects.toThrow(
      /append-only/,
    );
    expect(await prisma.securityEvent.count()).toBe(1);
  });
});
