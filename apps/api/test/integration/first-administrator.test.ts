import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  AppointmentRefused,
  appointAdministrator,
  parseArgs,
} from '../../src/cli/first-administrator';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  TEST_DATABASE_URL,
  assertDisposable,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The CLI runs where the API does not, with a plain client on the owner
 * connection. The tests hand it exactly that — not the scoped harness client —
 * because a function that only worked inside a scope the harness had opened
 * would pass here and fail on the host.
 */
suite('the first administrator', () => {
  let scoped: PrismaClient;
  let plain: PrismaClient;
  const ORIGIN = { host: 'test-host', user: 'operator' };

  beforeAll(() => {
    scoped = createTestClient();
    plain = new PrismaClient({
      datasources: { db: { url: assertDisposable(TEST_DATABASE_URL as string) } },
    });
  });
  afterAll(async () => {
    await scoped.$disconnect();
    await plain.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(scoped);
  });

  async function person(
    overrides: {
      email?: string;
      emailVerified?: boolean;
      isActive?: boolean;
      role?: 'USER' | 'ADMIN' | 'FINANCE';
      tenantId?: string;
    } = {},
  ): Promise<{ id: string; email: string }> {
    const email = overrides.email ?? `person-${randomUUID().slice(0, 8)}@test.local`;
    // The plain client for a person in another tenant: the scoped one refuses
    // to write a row for a tenant that is not in scope, which is its job.
    const client = overrides.tenantId === undefined ? scoped : plain;
    const user = await client.user.create({
      data: {
        tenantId: overrides.tenantId ?? DEFAULT_TENANT_ID,
        email,
        passwordHash: 'not-a-real-hash',
        displayName: 'Somebody',
        emailVerified: overrides.emailVerified ?? true,
        isActive: overrides.isActive ?? true,
        role: overrides.role ?? 'USER',
      },
    });
    return { id: user.id, email };
  }

  async function session(userId: string): Promise<string> {
    const row = await scoped.refreshToken.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId,
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return row.id;
  }

  const appoint = (
    email: string,
    extra: Partial<Parameters<typeof appointAdministrator>[1]> = {},
  ) =>
    appointAdministrator(plain, {
      email,
      reason: 'first administrator after deployment',
      tenantSlug: DEFAULT_TENANT_SLUG,
      evenIfOneExists: false,
      origin: ORIGIN,
      ...extra,
    });

  it('appoints a verified, active person, ends their sessions, and records it as the host', async () => {
    const who = await person();
    const live = await session(who.id);
    const alreadyGone = await scoped.refreshToken.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        userId: who.id,
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: new Date(Date.now() - 1000),
      },
    });

    const outcome = await appoint(`  ${who.email.toUpperCase()} `);

    expect(outcome).toEqual({ kind: 'appointed', userId: who.id, sessionsEnded: 1 });
    const after = await scoped.user.findUniqueOrThrow({ where: { id: who.id } });
    expect(after.role).toBe('ADMIN');
    const token = await scoped.refreshToken.findUniqueOrThrow({ where: { id: live } });
    expect(token.revokedAt).not.toBeNull();
    const earlier = await scoped.refreshToken.findUniqueOrThrow({ where: { id: alreadyGone.id } });
    expect(earlier.revokedAt).toEqual(alreadyGone.revokedAt);

    const audit = await scoped.auditLog.findMany({ where: { action: 'user.role_assigned' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: null,
      actorType: 'SYSTEM',
      resourceType: 'user',
      resourceId: who.id,
      before: { role: 'USER' },
      after: {
        role: 'ADMIN',
        reason: 'first administrator after deployment',
        sessionsEnded: 1,
        appointedFrom: 'host',
        host: 'test-host',
        hostUser: 'operator',
        administratorsBefore: 0,
        evenIfOneExists: false,
      },
    });
  });

  it('is a no-op for somebody who is already an administrator', async () => {
    const who = await person({ role: 'ADMIN' });
    const live = await session(who.id);

    await expect(appoint(who.email)).resolves.toEqual({ kind: 'already', userId: who.id });

    const token = await scoped.refreshToken.findUniqueOrThrow({ where: { id: live } });
    expect(token.revokedAt).toBeNull();
    expect(await scoped.auditLog.count()).toBe(0);
  });

  it('refuses once the tenant has an active administrator, and names the way in', async () => {
    await person({ role: 'ADMIN' });
    const next = await person();

    await expect(appoint(next.email)).rejects.toThrow(/already has an administrator/);
    await expect(appoint(next.email)).rejects.toThrow(/POST \/admin\/users\/:id\/role/);
    const unchanged = await scoped.user.findUniqueOrThrow({ where: { id: next.id } });
    expect(unchanged.role).toBe('USER');
  });

  it('does not count a suspended administrator as one', async () => {
    await person({ role: 'ADMIN', isActive: false });
    const next = await person();

    await expect(appoint(next.email)).resolves.toMatchObject({ kind: 'appointed' });
  });

  it('breaks the glass when told to, and records that it was told', async () => {
    await person({ role: 'ADMIN' });
    const next = await person();

    await expect(appoint(next.email, { evenIfOneExists: true })).resolves.toMatchObject({
      kind: 'appointed',
    });
    const audit = await scoped.auditLog.findFirstOrThrow({
      where: { action: 'user.role_assigned' },
    });
    expect(audit.after).toMatchObject({ evenIfOneExists: true, administratorsBefore: 1 });
  });

  it('refuses somebody who does not exist, is unverified, or is suspended', async () => {
    await expect(appoint('nobody@test.local')).rejects.toThrow(/never created from a host/);

    const unverified = await person({ emailVerified: false });
    await expect(appoint(unverified.email)).rejects.toThrow(/not verified/);

    const suspended = await person({ isActive: false });
    await expect(appoint(suspended.email)).rejects.toThrow(/suspended/);

    for (const id of [unverified.id, suspended.id]) {
      const row = await scoped.user.findUniqueOrThrow({ where: { id } });
      expect(row.role).toBe('USER');
    }
    expect(await scoped.auditLog.count()).toBe(0);
  });

  it('refuses without a reason worth reading', async () => {
    const who = await person();
    await expect(appoint(who.email, { reason: 'ok' })).rejects.toThrow(AppointmentRefused);
  });

  it('looks in the tenant it was given and nowhere else', async () => {
    const otherTenant = await createTenant(scoped, 'other-firm');
    const elsewhere = await person({ tenantId: otherTenant, email: 'shared@test.local' });
    const here = await person({ email: 'shared@test.local' });
    await person({ role: 'ADMIN' }); // this tenant has one; the other has none

    await expect(appoint('shared@test.local')).rejects.toThrow(/already has an administrator/);
    await expect(appoint('shared@test.local', { tenantSlug: 'other-firm' })).resolves.toMatchObject(
      { kind: 'appointed', userId: elsewhere.id },
    );
    await expect(appoint('shared@test.local', { tenantSlug: 'no-such-firm' })).rejects.toThrow(
      /No tenant/,
    );

    const untouched = await scoped.user.findUniqueOrThrow({ where: { id: here.id } });
    expect(untouched.role).toBe('USER');
  });

  it('is one transaction: a role changed underneath it leaves nothing behind', async () => {
    const who = await person();
    const live = await session(who.id);

    // Another operator's terminal wins between this one's read and its write.
    const original = plain.$transaction.bind(plain);
    const racing = new Proxy(plain, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async (fn: (tx: unknown) => Promise<unknown>) => {
          await scoped.user.update({ where: { id: who.id }, data: { role: 'FINANCE' } });
          return original(fn as never);
        };
      },
    });

    await expect(
      appointAdministrator(racing as PrismaClient, {
        email: who.email,
        reason: 'first administrator after deployment',
        tenantSlug: DEFAULT_TENANT_SLUG,
        evenIfOneExists: false,
        origin: ORIGIN,
      }),
    ).rejects.toThrow(/changed while this ran/);

    const row = await scoped.user.findUniqueOrThrow({ where: { id: who.id } });
    expect(row.role).toBe('FINANCE');
    const token = await scoped.refreshToken.findUniqueOrThrow({ where: { id: live } });
    expect(token.revokedAt).toBeNull();
    expect(await scoped.auditLog.count()).toBe(0);
  });
});

describe('the arguments', () => {
  it('reads the flags and falls back to the deployment tenant', () => {
    expect(
      parseArgs(['--email', 'a@b.test', '--reason', 'because deployment'], {
        TENANT_DEFAULT_SLUG: 'firm',
      }),
    ).toEqual({
      email: 'a@b.test',
      reason: 'because deployment',
      tenantSlug: 'firm',
      evenIfOneExists: false,
    });
    expect(
      parseArgs(
        ['--tenant', 'x', '--even-if-one-exists', '--email', 'a@b.test', '--reason', 'r'],
        {},
      ),
    ).toMatchObject({ tenantSlug: 'x', evenIfOneExists: true });
    expect(parseArgs(['--email', 'a@b.test', '--reason', 'r'], {}).tenantSlug).toBe('default');
  });

  it('refuses a missing value, a missing flag, and a flag it does not know', () => {
    expect(() => parseArgs(['--email'], {})).toThrow(/needs a value/);
    expect(() => parseArgs(['--email', '--reason', 'r'], {})).toThrow(/needs a value/);
    expect(() => parseArgs(['--reason', 'r'], {})).toThrow(/--email is required/);
    expect(() => parseArgs(['--email', 'a@b.test'], {})).toThrow(/--reason is required/);
    expect(() => parseArgs(['--email', 'a@b.test', '--reason', 'r', '--force'], {})).toThrow(
      /Unknown argument/,
    );
  });
});
