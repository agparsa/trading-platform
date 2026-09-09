import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { UserRole } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { BreakGlassService } from '../../src/security/break-glass.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

/**
 * Break-glass (§9).
 *
 * The tests that matter are the refusals. A break-glass feature that works is
 * easy; one that cannot be turned into a privilege escalation, a cross-firm
 * read, or a quiet permanent back door is the whole exercise.
 */
suite('break-glass', () => {
  let prisma: PrismaClient;
  let service: BreakGlassService;

  const config = (maxTtlMs = 60 * 60 * 1000) =>
    new ConfigService({ BREAK_GLASS_MAX_TTL_MS: maxTtlMs } as never);

  const build = (maxTtlMs?: number) =>
    new BreakGlassService(
      prisma as unknown as PrismaService,
      config(maxTtlMs) as never,
      new AuditService(prisma as unknown as PrismaService),
    );

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    service = build();
  });

  const person = async (role: UserRole = UserRole.USER) => {
    const { userId } = await createAccount(prisma, { balance: '100' });
    await prisma.user.update({ where: { id: userId }, data: { role } });
    return userId;
  };

  const open = (actorId: string, subjectUserId: string, over: Record<string, unknown> = {}) =>
    withTenant(TENANT, () =>
      service.open({
        actorId,
        actorRole: UserRole.ADMIN,
        subjectUserId,
        reason: 'Customer cannot see their closed trades; ticket 4471',
        ...over,
      }),
    );

  it('opens a grant, records the reason, and expires it', async () => {
    const admin = await person(UserRole.ADMIN);
    const trader = await person();

    const grant = await open(admin, trader);
    const row = await prisma.breakGlassGrant.findUniqueOrThrow({ where: { id: grant.id } });

    expect(row.actorId).toBe(admin);
    expect(row.subjectUserId).toBe(trader);
    expect(row.scope).toBe('READ_ONLY');
    expect(row.reason).toMatch(/ticket 4471/);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.endedAt).toBeNull();
  });

  /**
   * The audit trail names the staff member, always. That is the whole reason
   * this is a grant and not a minted token: a token saying "you are the trader"
   * would make every row afterwards say the trader did it.
   */
  it('records the opening against the staff member, not the subject', async () => {
    const admin = await person(UserRole.ADMIN);
    const trader = await person();
    const grant = await open(admin, trader);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'BREAK_GLASS_OPENED' },
    });
    expect(entry.actorId).toBe(admin);
    expect(entry.resourceId).toBe(trader);
    expect(JSON.stringify(entry.after)).toContain(grant.id);
  });

  /**
   * And the *subject* is told, in their own feed. A break-glass nobody outside
   * the room can see is indistinguishable from snooping.
   */
  it('tells the subject in their own security feed', async () => {
    const admin = await person(UserRole.ADMIN);
    const trader = await person();
    await open(admin, trader);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { kind: 'BREAK_GLASS_OPENED' },
    });
    expect(event.userId).toBe(trader);
    expect(event.actorId).toBe(admin);
    expect(event.severity).toBe('WARNING');
  });

  describe('the refusals', () => {
    /**
     * The escalation this feature would otherwise be. Support tooling must not
     * be a route to becoming a super administrator.
     */
    it('refuses a subject who holds powers the actor does not', async () => {
      const admin = await person(UserRole.ADMIN);
      const superior = await person(UserRole.PLATFORM_SUPER_ADMIN);

      await expect(open(admin, superior)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await prisma.breakGlassGrant.count()).toBe(0);
    });

    it('refuses breaking glass on yourself', async () => {
      const admin = await person(UserRole.ADMIN);
      await expect(open(admin, admin)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    /** A reason nobody can be asked about afterwards is not a reason. */
    it('refuses a reason too short to mean anything', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      for (const reason of ['', '   ', 'x', 'because']) {
        await expect(open(admin, trader, { reason })).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
      }
      expect(await prisma.breakGlassGrant.count()).toBe(0);
    });

    it('refuses a subject who does not exist', async () => {
      const admin = await person(UserRole.ADMIN);
      await expect(
        open(admin, '00000000-0000-4000-8000-0000000000aa'),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('refuses a disabled account — there is nothing to look at', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      await prisma.user.update({ where: { id: trader }, data: { isActive: false } });

      await expect(open(admin, trader)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    /**
     * A grant is an errand, not a mode. Asking for longer is capped rather than
     * refused: the person is mid-incident and does not need an argument about a
     * number.
     */
    it('caps the window rather than granting what was asked for', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      service = build(60_000);

      const grant = await open(admin, trader, { minutes: 480 });
      expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    });
  });

  describe('resolving one for a request', () => {
    it('resolves a live grant and counts the use', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);

      const live = await withTenant(TENANT, () => service.resolve(admin, grant.id));
      expect(live?.subjectUserId).toBe(trader);

      const row = await prisma.breakGlassGrant.findUniqueOrThrow({ where: { id: grant.id } });
      expect(row.uses).toBe(1);
    });

    /** Somebody else's grant is not a grant. */
    it('refuses a grant belonging to another member of staff', async () => {
      const admin = await person(UserRole.ADMIN);
      const other = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);

      expect(await withTenant(TENANT, () => service.resolve(other, grant.id))).toBeNull();
    });

    /**
     * Expiry is compared in the database, not in this process — one clock,
     * shared by everything that asks. The same lesson as the leadership lease.
     */
    it('refuses an expired grant', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);
      /*
       * Both timestamps move. A CHECK constraint refuses `expires_at <=
       * created_at`, which is the constraint doing its job: a grant that
       * expired before it was created is not an expired grant, it is a
       * corrupted row, and the database is right to refuse one.
       */
      await prisma.breakGlassGrant.update({
        where: { id: grant.id },
        data: {
          createdAt: new Date(Date.now() - 7_200_000),
          expiresAt: new Date(Date.now() - 3_600_000),
        },
      });

      expect(await withTenant(TENANT, () => service.resolve(admin, grant.id))).toBeNull();
    });

    it('refuses a grant that was ended early', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);
      await withTenant(TENANT, () => service.close(admin, grant.id));

      expect(await withTenant(TENANT, () => service.resolve(admin, grant.id))).toBeNull();
    });

    it('refuses an id that is not a grant', async () => {
      const admin = await person(UserRole.ADMIN);
      expect(
        await withTenant(TENANT, () =>
          service.resolve(admin, '00000000-0000-4000-8000-0000000000bb'),
        ),
      ).toBeNull();
    });
  });

  describe('closing', () => {
    it('records the close and how much the grant was used', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);
      await withTenant(TENANT, () => service.resolve(admin, grant.id));
      await withTenant(TENANT, () => service.close(admin, grant.id));

      const row = await prisma.breakGlassGrant.findUniqueOrThrow({ where: { id: grant.id } });
      expect(row.endedAt).not.toBeNull();
      expect(row.endedByUserId).toBe(admin);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'BREAK_GLASS_CLOSED' },
      });
      expect(JSON.stringify(entry.after)).toContain('"uses":1');
    });

    /** Idempotent: closing a closed grant is not an error, and writes nothing twice. */
    it('is idempotent', async () => {
      const admin = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);

      await withTenant(TENANT, () => service.close(admin, grant.id));
      await withTenant(TENANT, () => service.close(admin, grant.id));

      expect(await prisma.auditLog.count({ where: { action: 'BREAK_GLASS_CLOSED' } })).toBe(1);
    });

    it('will not let one person close another’s grant', async () => {
      const admin = await person(UserRole.ADMIN);
      const other = await person(UserRole.ADMIN);
      const trader = await person();
      const grant = await open(admin, trader);

      await withTenant(TENANT, () => service.close(other, grant.id));

      const row = await prisma.breakGlassGrant.findUniqueOrThrow({ where: { id: grant.id } });
      expect(row.endedAt).toBeNull();
    });
  });
});
