import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withTenant } from '@tp/tenancy';
import { AdminAlertsService } from '../../../worker/src/jobs/admin-alerts.service';
import type { PrismaService as WorkerPrisma } from '../../../worker/src/prisma.service';
import { AdminAlertRulesService } from '../../src/admin-alerts/admin-alerts.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * Admin alert rules, read by the worker the way it reads them every minute,
 * and written and acknowledged through the API's service.
 */
suite('Admin alerts (integration)', () => {
  let prisma: PrismaClient;
  let sweep: AdminAlertsService;
  let rules: AdminAlertRulesService;
  let actor: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    sweep = new AdminAlertsService(prisma as unknown as WorkerPrisma);
    rules = new AdminAlertRulesService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
    actor = (await createAccount(prisma, { email: 'ops@test.local' })).userId;
  });

  const signUps = async (count: number) => {
    for (let i = 0; i < count; i += 1) await createAccount(prisma);
  };

  it('raises once when a count crosses its threshold, stays quiet while it stays over, and again after the quiet period', async () => {
    const rule = await rules.save(actor, {
      name: 'Busy sign-ups',
      metric: 'REGISTRATIONS_24H',
      comparator: 'ABOVE',
      threshold: 3,
      cooldownMinutes: 60,
      enabled: true,
    });
    const t0 = new Date();
    // The actor is one sign-up already; three more makes four, which is above three.
    expect(await sweep.evaluate(t0)).toEqual({ evaluated: 1, raised: 0 });
    await signUps(3);
    expect((await sweep.evaluate(t0)).raised).toBe(1);
    expect((await sweep.evaluate(new Date(t0.getTime() + 5 * 60_000))).raised).toBe(0);
    expect((await sweep.evaluate(new Date(t0.getTime() + 61 * 60_000))).raised).toBe(1);

    const listed = await rules.alerts('open', 50);
    expect(listed.open).toBe(2);
    expect(listed.alerts[0]).toMatchObject({
      ruleId: rule?.id,
      ruleName: 'Busy sign-ups',
      threshold: 3,
      value: 4,
    });
    const [stored] = await rules.rules();
    expect(stored).toMatchObject({ lastValue: 4, inBreach: true });
  });

  it('raises again at once when a breach clears and comes back', async () => {
    await rules.save(actor, {
      name: 'Any sign-up',
      metric: 'REGISTRATIONS_24H',
      comparator: 'ABOVE',
      threshold: 1,
      cooldownMinutes: 600,
      enabled: true,
    });
    const now = new Date();
    await signUps(1);
    expect((await sweep.evaluate(now)).raised).toBe(1);
    // A day later the count is 0 again — the breach clears…
    expect((await sweep.evaluate(new Date(now.getTime() + 25 * 3_600_000))).raised).toBe(0);
    // …and the next breach raises without waiting out the quiet period.
    await signUps(2);
    expect((await sweep.evaluate(new Date())).raised).toBe(1);
  });

  it('acknowledges once, with a note, and audits it', async () => {
    await rules.save(actor, {
      name: 'Any sign-up',
      metric: 'REGISTRATIONS_24H',
      comparator: 'ABOVE',
      threshold: 0,
      cooldownMinutes: 60,
      enabled: true,
    });
    await sweep.evaluate(new Date());
    const [alert] = (await rules.alerts('open', 10)).alerts;
    if (alert === undefined) throw new Error('no alert was raised');
    await rules.acknowledge(actor, alert.id, 'expected: launch day');
    expect((await rules.alerts('open', 10)).open).toBe(0);
    await expect(rules.acknowledge(actor, alert.id, null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const all = await rules.alerts('all', 10);
    expect(all.alerts[0]).toMatchObject({ note: 'expected: launch day' });
    expect(await prisma.auditLog.count({ where: { action: 'ALERT_ACKNOWLEDGED' } })).toBe(1);
  });

  it('ignores disabled rules and refuses a rule that could never fire', async () => {
    await rules.save(actor, {
      name: 'Off',
      metric: 'REGISTRATIONS_24H',
      comparator: 'ABOVE',
      threshold: 0,
      cooldownMinutes: 60,
      enabled: false,
    });
    expect(await sweep.evaluate(new Date())).toEqual({ evaluated: 0, raised: 0 });
    await expect(
      rules.save(actor, {
        name: 'Never',
        metric: 'REGISTRATIONS_24H',
        comparator: 'BELOW',
        threshold: 0,
        cooldownMinutes: 60,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      rules.save(actor, {
        name: 'Unknown',
        metric: 'NOT_A_METRIC',
        comparator: 'ABOVE',
        threshold: 1,
        cooldownMinutes: 60,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('counts each firm’s own rows only', async () => {
    const other = await createTenant(prisma, 'alerts-other');
    await withTenant({ tenantId: other, slug: 'alerts-other', kind: 'BROKER' }, async () => {
      for (let i = 0; i < 5; i += 1) await createAccount(prisma, { tenantId: other });
    });
    await rules.save(actor, {
      name: 'Sign-ups here',
      metric: 'REGISTRATIONS_24H',
      comparator: 'ABOVE',
      threshold: 2,
      cooldownMinutes: 60,
      enabled: true,
    });
    // Five sign-ups at the other firm, one here: nothing to raise here.
    expect((await sweep.evaluate(new Date())).raised).toBe(0);
    const stored = await prisma.adminAlertRule.findFirstOrThrow({
      where: { tenantId: DEFAULT_TENANT_ID },
    });
    expect(stored.lastValue).toBe(1);
  });
});
