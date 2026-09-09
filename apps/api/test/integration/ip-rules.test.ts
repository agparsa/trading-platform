import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { UserRole } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { IpRulesService } from '../../src/security/ip-rules.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * Per-tenant IP rules (§46).
 *
 * The pure evaluation is covered by `ip-rules.test.ts` next to the source. What
 * is proved here is everything that needs a database: that one firm's rules
 * cannot be seen or enforced by another, that the refusals actually refuse
 * before anything is written, and — the point of the whole feature — that the
 * way *out* of a bad rule set is never closed.
 */
suite('ip rules', () => {
  let prisma: PrismaClient;

  /** Explicit, always: `undefined` is a meaningful value here, not an absence. */
  const build = (hops: number | undefined) =>
    new IpRulesService(
      prisma as unknown as PrismaService,
      new ConfigService({ TRUSTED_PROXY_HOPS: hops } as never) as never,
      new AuditService(prisma as unknown as PrismaService),
    );

  let service: IpRulesService;
  let admin: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    service = build(1);
    const { userId } = await createAccount(prisma, { balance: '0' });
    await prisma.user.update({ where: { id: userId }, data: { role: UserRole.ADMIN } });
    admin = userId;
  });

  const create = (
    over: Partial<Parameters<IpRulesService['create']>[0]> = {},
    svc: IpRulesService = service,
  ) =>
    withTenant(TENANT, () =>
      svc.create({
        actorId: admin,
        actorAddress: '203.0.113.7',
        actorAddressTrusted: true,
        cidr: '203.0.113.0/24',
        kind: 'ALLOW',
        scope: 'STAFF',
        note: 'The Amsterdam office',
        ...over,
      }),
    );

  it('stores a rule, enforces it, and names the author', async () => {
    const rule = await create();

    const stored = await prisma.tenantIpRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored.cidr).toBe('203.0.113.0/24');
    expect(stored.enabled).toBe(true);
    expect(stored.createdByUserId).toBe(admin);
    expect(stored.note).toBe('The Amsterdam office');

    const inside = await withTenant(TENANT, () => service.decide('203.0.113.9', 'STAFF'));
    const outside = await withTenant(TENANT, () => service.decide('198.51.100.4', 'STAFF'));
    expect(inside.allowed).toBe(true);
    expect(outside.allowed).toBe(false);
  });

  /**
   * The refusal that the rest of the design rests on. Written as the mistake
   * actually gets made: an administrator in Amsterdam allow-listing the London
   * office, from Amsterdam.
   */
  it('refuses a rule that would shut its author out, and writes nothing', async () => {
    await expect(create({ cidr: '198.51.100.0/24' })).rejects.toThrow(/shut you out/i);
    expect(await prisma.tenantIpRule.count()).toBe(0);
  });

  /**
   * The rule that looks harmless alone. An ALLOW covering the author is still a
   * lock-out when an existing DENY covers them too, because DENY wins — so the
   * check has to run against the set as it would be, not the new rule.
   */
  it('refuses a rule that is only a lock-out in combination with the existing set', async () => {
    await create({ cidr: '198.51.100.0/24', kind: 'DENY', note: 'A hostile range' });
    await create();
    await expect(
      create({
        actorAddress: '198.51.100.5',
        cidr: '198.51.100.0/24',
        kind: 'ALLOW',
        note: 'My own address, surely fine',
      }),
    ).rejects.toThrow(/shut you out/i);
    expect(await prisma.tenantIpRule.count()).toBe(2);
  });

  it('refuses every rule until the deployment says what is in front of it', async () => {
    await expect(create({}, build(undefined))).rejects.toThrow(/TRUSTED_PROXY_HOPS/);
    expect(build(undefined).enforceable()).toBe(false);
    expect(await prisma.tenantIpRule.count()).toBe(0);
  });

  /**
   * Zero is a claim, not an absence. A deployment that has said there is
   * nothing in front of it can see its clients perfectly well, and refusing it
   * the feature would be refusing it for having answered the question.
   */
  it('accepts a rule from a deployment that has declared no proxies', async () => {
    const direct = build(0);
    expect(direct.enforceable()).toBe(true);
    const rule = await create({}, direct);
    expect(rule.enabled).toBe(true);
  });

  it("refuses a rule when the author's own address is not trusted", async () => {
    await expect(create({ actorAddressTrusted: false })).rejects.toThrow(/cannot be determined/i);
    expect(await prisma.tenantIpRule.count()).toBe(0);
  });

  it('refuses a range it cannot parse', async () => {
    await expect(create({ cidr: '203.0.113.0/33' })).rejects.toThrow(/not an address or a range/);
    expect(await prisma.tenantIpRule.count()).toBe(0);
  });

  /**
   * The way out. Both of these would be refused as creations; neither is
   * refused as a removal, because a firm that has locked itself out has to be
   * able to undo it from the screen rather than from a database console.
   */
  it('never refuses disabling or deleting, even from an address the rules exclude', async () => {
    const rule = await create();

    const off = await withTenant(TENANT, () =>
      service.setEnabled({
        actorId: admin,
        actorAddress: '198.51.100.5',
        actorAddressTrusted: false,
        id: rule.id,
        enabled: false,
      }),
    );
    expect(off.enabled).toBe(false);
    expect(await withTenant(TENANT, () => service.active())).toHaveLength(0);

    await withTenant(TENANT, () => service.remove(admin, rule.id));
    expect(await prisma.tenantIpRule.count()).toBe(0);
  });

  /**
   * "Never refused" has to mean in every state, not just the tidy one. A firm
   * that has locked itself out will click the same switch twice, from the wrong
   * address, in a hurry; the second click must not be the one that refuses.
   */
  it('never refuses disabling, whatever state the rule is already in', async () => {
    const rule = await create();
    const off = {
      actorId: admin,
      actorAddress: '198.51.100.5',
      actorAddressTrusted: false,
      id: rule.id,
      enabled: false,
    };
    await withTenant(TENANT, () => service.setEnabled(off));
    await expect(withTenant(TENANT, () => service.setEnabled(off))).resolves.toEqual({
      id: rule.id,
      enabled: false,
    });
  });

  it('checks re-enabling exactly as it checks creation', async () => {
    const rule = await create({ cidr: '198.51.100.0/24', kind: 'DENY', note: 'A hostile range' });
    await withTenant(TENANT, () =>
      service.setEnabled({
        actorId: admin,
        actorAddress: '203.0.113.7',
        actorAddressTrusted: true,
        id: rule.id,
        enabled: false,
      }),
    );

    await expect(
      withTenant(TENANT, () =>
        service.setEnabled({
          actorId: admin,
          actorAddress: '198.51.100.5',
          actorAddressTrusted: true,
          id: rule.id,
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/shut you out/i);

    const stored = await prisma.tenantIpRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored.enabled).toBe(false);
  });

  /** A disabled rule is not a rule. The guard reads `active()` and nothing else. */
  it('leaves a disabled rule out of the decision', async () => {
    const rule = await create({
      cidr: '198.51.100.0/24',
      kind: 'DENY',
      note: 'A range we were seeing credential stuffing from',
    });
    expect((await withTenant(TENANT, () => service.decide('198.51.100.4', 'STAFF'))).allowed).toBe(
      false,
    );

    await withTenant(TENANT, () =>
      service.setEnabled({
        actorId: admin,
        actorAddress: '203.0.113.7',
        actorAddressTrusted: true,
        id: rule.id,
        enabled: false,
      }),
    );
    expect((await withTenant(TENANT, () => service.decide('198.51.100.4', 'STAFF'))).allowed).toBe(
      true,
    );
  });

  /**
   * One firm's rules must never reach another's. The failure would be silent
   * and total: firm B's staff refused by a range firm A wrote.
   */
  it('never lets one firm’s rules touch another’s', async () => {
    const otherId = await createTenant(prisma, 'other-firm');
    const other = { tenantId: otherId, slug: 'other-firm' };
    const { userId: otherAdmin } = await withTenant(other, () =>
      createAccount(prisma, { tenantId: otherId, email: 'other-admin@test.local' }),
    );

    await create({ cidr: '203.0.113.0/24' });
    await withTenant(other, () =>
      service.create({
        actorId: otherAdmin,
        actorAddress: '198.51.100.5',
        actorAddressTrusted: true,
        cidr: '198.51.100.0/24',
        kind: 'ALLOW',
        scope: 'STAFF',
        note: 'The other firm’s office',
      }),
    );

    expect(await withTenant(TENANT, () => service.active())).toHaveLength(1);
    expect(await withTenant(other, () => service.active())).toHaveLength(1);

    // Each firm's own address passes; the other firm's does not.
    expect((await withTenant(TENANT, () => service.decide('203.0.113.9', 'STAFF'))).allowed).toBe(
      true,
    );
    expect((await withTenant(TENANT, () => service.decide('198.51.100.5', 'STAFF'))).allowed).toBe(
      false,
    );
    expect((await withTenant(other, () => service.decide('198.51.100.5', 'STAFF'))).allowed).toBe(
      true,
    );
    expect((await withTenant(other, () => service.decide('203.0.113.9', 'STAFF'))).allowed).toBe(
      false,
    );
  });

  /** A rule scoped to staff must not reach customers, and the reverse. */
  it('applies a rule only in the scope it was written for', async () => {
    await create({ cidr: '203.0.113.0/24', scope: 'STAFF' });

    expect((await withTenant(TENANT, () => service.decide('198.51.100.4', 'STAFF'))).allowed).toBe(
      false,
    );
    expect(
      (await withTenant(TENANT, () => service.decide('198.51.100.4', 'EVERYONE'))).allowed,
    ).toBe(true);
  });

  /**
   * Every change to who may reach the firm is audited, and lands in the feed of
   * the person whose session made it — the one person certain to notice a
   * change they did not make.
   */
  it('audits every change and puts it in the actor’s security feed', async () => {
    const rule = await create();
    await withTenant(TENANT, () =>
      service.setEnabled({
        actorId: admin,
        actorAddress: '203.0.113.7',
        actorAddressTrusted: true,
        id: rule.id,
        enabled: false,
      }),
    );
    await withTenant(TENANT, () => service.remove(admin, rule.id));

    const actions = await prisma.auditLog.findMany({
      where: { resourceType: 'TenantIpRule' },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true },
    });
    expect(actions.map((row) => row.action)).toEqual([
      'IP_RULE_CREATED',
      'IP_RULE_DISABLED',
      'IP_RULE_DELETED',
    ]);
    expect(actions.every((row) => row.actorId === admin)).toBe(true);

    const events = await prisma.securityEvent.findMany({
      where: { kind: 'IP_RULE_CHANGED' },
      select: { userId: true, severity: true },
    });
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.userId === admin)).toBe(true);
    expect(events.every((event) => event.severity === 'WARNING')).toBe(true);
  });

  it('refuses to disable or delete a rule that does not exist', async () => {
    const absent = '00000000-0000-4000-8000-00000000dead';
    await expect(withTenant(TENANT, () => service.remove(admin, absent))).rejects.toThrow(
      /No such rule/,
    );
    await expect(
      withTenant(TENANT, () =>
        service.setEnabled({
          actorId: admin,
          actorAddress: '203.0.113.7',
          actorAddressTrusted: true,
          id: absent,
          enabled: false,
        }),
      ),
    ).rejects.toThrow(/No such rule/);
  });
});
