import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { ReportKind } from '@tp/reports-core';
import { Permission, TradingErrorCode, UserRole } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { ReportsService } from '../../src/reports/reports.service';
import { ReportsService as ReportBuilder } from '../../../worker/src/jobs/reports.service';
import { MaintenanceService } from '../../../worker/src/jobs/maintenance.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { RolesService } from '../../src/permissions/roles.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SecretBoxService } from '../../src/common/crypto/crypto.module';
import { redisStub } from './redis-stub';
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

/**
 * Reports: who may ask for one, what goes in it, and who may have the file.
 *
 * The file is the easy half. What these tests are for is the two properties
 * that would be expensive to get wrong and cheap to leave untested:
 *
 * **A report must not cross a firm.** A report of the book is a file full of
 * one firm's trades. It is built by a worker whose job payload carries nothing
 * but an id, precisely so that the tenant comes from the row rather than from
 * the queue — and the file must contain that firm's rows and no others.
 *
 * **A report must not outlive the permission it was built on.** A file lives
 * for days. A person's role can change in that time — they move desks, they are
 * demoted during an investigation, an elevated grant expires. Checking only at
 * request time means Monday's export is still theirs on Friday, after the
 * access it was based on is gone.
 */
suite('reports', () => {
  let prisma: PrismaClient;
  let reports: ReportsService;
  let builder: ReportBuilder;
  let maintenance: MaintenanceService;
  let roles: RolesService;
  let secrets: SecretBox;
  let published: { name: string; payload: unknown }[];
  let redis: ReturnType<typeof redisStub>;

  const KEY = generateEncryptionKey('test');
  const alpha = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };
  let beta: { tenantId: string; slug: string };

  let admin: { userId: string; accountId: string };
  let betaAdmin: { userId: string; accountId: string };

  /** A stand-in for the queue: the API publishes, the test runs the job itself. */
  const queue = {
    publish: async (name: string, _job: string, payload: unknown) => {
      published.push({ name, payload });
    },
  };

  const config = (over: Record<string, unknown> = {}) =>
    new ConfigService({
      SECRET_ENCRYPTION_KEYS: KEY,
      REPORT_RETENTION_DAYS: 14,
      ...over,
    } as never);

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    published = [];
    secrets = new SecretBox(parseEncryptionKeys(KEY));

    const prismaService = prisma as unknown as PrismaService;
    redis = redisStub();
    roles = new RolesService(prismaService, redis.service, new AuditService(prismaService));
    reports = new ReportsService(
      prismaService,
      new AuditService(prismaService),
      roles,
      queue as never,
      secrets as SecretBoxService,
    );
    builder = new ReportBuilder(prismaService as never, config() as never, secrets);
    maintenance = new MaintenanceService(prismaService as never);

    admin = await createAccount(prisma, { balance: '10000', email: 'admin@alpha.test' });
    const betaId = await createTenant(prisma, 'beta-firm', 'beta-firm.example.test');
    beta = { tenantId: betaId, slug: 'beta-firm' };
    betaAdmin = await withTenant(beta, () =>
      createAccount(prisma, { balance: '10000', email: 'admin@beta.test', tenantId: betaId }),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const ADMIN = (id: string) => ({ id, role: UserRole.ADMIN as string });
  const window = () => ({
    from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 3_600_000).toISOString(),
  });

  /** A ledger entry the report will find, in whichever firm is in scope. */
  async function ledgerEntry(accountId: string, tenantId: string, amount: string) {
    return prisma.balanceLedger.create({
      data: {
        tenantId,
        accountId,
        type: 'DEPOSIT',
        amount,
        balanceAfter: amount,
        currency: 'USD',
        description: 'a deposit',
      },
    });
  }

  const build = async (reportId: string) => builder.build(reportId);

  /**
   * Takes `accounts.read_any` off a role, the way editing the role would.
   *
   * The grant rows are what `RolesService.permissionsFor` reads, so removing
   * one is the same state an administrator produces through the roles screen —
   * and it is the realistic way somebody ends up holding `reports.run` without
   * the permission a kind needs.
   */
  async function narrowRole(role: string): Promise<void> {
    const row = await prisma.role.findFirstOrThrow({ where: { key: role } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: row.id, permission: Permission.ACCOUNTS_READ_ANY },
    });
    await roles.invalidate(DEFAULT_TENANT_ID);
  }

  describe('asking for one', () => {
    it('queues a job and records the request', async () => {
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      expect(view.status).toBe('QUEUED');
      expect(published).toEqual([
        { name: 'reports', payload: { reportId: view.id } },
      ]);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'report.requested' } });
      expect(audit?.resourceId).toBe(view.id);
    });

    it('refuses a window that is backwards, in the words the operator needs', async () => {
      await expect(
        reports.request(
          { kind: ReportKind.LEDGER, from: window().to, to: window().from },
          ADMIN(admin.userId),
        ),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('refuses a kind this platform does not produce', async () => {
      await expect(
        reports.request({ kind: 'EVERYTHING', ...window() }, ADMIN(admin.userId)),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    /**
     * The rule that keeps a report from being a way around a permission.
     *
     * Worth stating plainly what this is and is not today. Every built-in role
     * that holds `reports.run` also holds `accounts.read_any`, so for the two
     * kinds that exist the per-kind check never decides anything. It is there
     * for the two cases that are coming: a kind whose permission is narrower
     * than `accounts.read_any` — an audit export needing `audit.read`, say —
     * and a role an administrator has narrowed, which `RolesService` allows at
     * runtime.
     *
     * The second is what is simulated here, because it is the realistic one:
     * the grant is taken off the role in the database, exactly as editing the
     * role would, and the export is refused on the next request.
     */
    it('refuses a kind whose rows the asker could not read on screen', async () => {
      await narrowRole(UserRole.ADMIN);
      const held = await roles.permissionsFor(UserRole.ADMIN);
      expect(held.has(Permission.ACCOUNTS_READ_ANY), 'premise: the grant is gone').toBe(false);

      await expect(
        reports.request({ kind: ReportKind.LEDGER, ...window() }, ADMIN(admin.userId)),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
    });
  });

  describe('producing the file', () => {
    it('builds a CSV with a header, the rows, and a BOM for Excel', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '250');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );

      expect(await build(view.id)).toBe('built');

      const file = await reports.download(view.id, ADMIN(admin.userId));
      const text = file.bytes.toString('utf8');
      expect(text.startsWith('﻿'), 'Excel reads UTF-8 without a BOM as the local code page')
        .toBe(true);
      expect(text).toContain('"entry_id","account_number"');
      expect(text).toContain('"250"');
      expect(file.filename).toMatch(/^ledger-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it('records the row count, the size and the hash', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '250');
      await ledgerEntry(admin.accountId, alpha.tenantId, '75');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);

      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.rowCount).toBe(3); // two deposits, and the account's opening balance
      expect(row.sizeBytes).toBeGreaterThan(0);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.status).toBe('READY');
    });

    it('produces an empty-but-readable file when nothing happened in the window', async () => {
      // "Nothing happened" is a valid answer, and a file with no header is one
      // nobody can open.
      const view = await reports.request(
        {
          kind: ReportKind.LEDGER,
          from: new Date(Date.now() - 40 * 86_400_000).toISOString(),
          to: new Date(Date.now() - 39 * 86_400_000).toISOString(),
        },
        ADMIN(admin.userId),
      );
      await build(view.id);
      const file = await reports.download(view.id, ADMIN(admin.userId));
      expect(file.bytes.toString('utf8')).toContain('"entry_id"');
      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.rowCount).toBe(0);
    });

    /**
     * A retry must not produce a second file.
     *
     * BullMQ retries, and a duplicate publish is a thing that happens. The
     * claim is a conditional update, so the second attempt finds nothing to
     * claim and stops rather than rebuilding a file somebody may already have
     * downloaded.
     */
    it('does not rebuild a report a previous attempt already built', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '250');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      expect(await build(view.id)).toBe('built');
      const first = await prisma.report.findFirstOrThrow({ where: { id: view.id } });

      expect(await build(view.id)).toBe('skipped');
      const second = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(second.completedAt?.toISOString()).toBe(first.completedAt?.toISOString());
      expect(second.sha256).toBe(first.sha256);
    });

    it('records a failure in words, and never a stack trace', async () => {
      const blind = new ReportBuilder(
        prisma as unknown as never,
        config({ SECRET_ENCRYPTION_KEYS: '' }) as never,
      );
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      expect(await blind.build(view.id)).toBe('failed');

      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.status).toBe('FAILED');
      expect(row.error).toContain('SECRET_ENCRYPTION_KEYS');
      expect(row.error).not.toContain('at ');
    });
  });

  /**
   * The audit export, and the first kind whose permission decides something.
   *
   * Until this kind, every role holding `reports.run` also held the permission
   * every kind needed — so the per-kind check was correct and inert.
   * `PLATFORM_OPERATOR` holds `reports.run` and not `audit.read`, so this is
   * the check refusing a real request from a real role rather than waiting for
   * a role edit to give it something to do.
   */
  describe('the audit trail', () => {
    const OPERATOR = (id: string) => ({ id, role: UserRole.PLATFORM_OPERATOR as string });

    it('refuses a role that may run reports but may not read the audit trail', async () => {
      const held = await roles.permissionsFor(UserRole.PLATFORM_OPERATOR);
      expect(held.has(Permission.REPORTS_RUN), 'premise: may ask for reports').toBe(true);
      expect(held.has(Permission.AUDIT_READ), 'premise: may not read the audit trail').toBe(false);

      await expect(
        reports.request({ kind: ReportKind.AUDIT, ...window() }, OPERATOR(admin.userId)),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });

      // And the same role may still have the kinds it can read.
      await expect(
        reports.request({ kind: ReportKind.LEDGER, ...window() }, OPERATOR(admin.userId)),
      ).resolves.toBeDefined();
    });

    it('exports the rows with their before and after intact', async () => {
      // Requesting a report writes an audit row, so there is always one to find.
      const view = await reports.request(
        { kind: ReportKind.AUDIT, ...window() },
        ADMIN(admin.userId),
      );
      expect(await build(view.id)).toBe('built');

      const text = (await reports.download(view.id, ADMIN(admin.userId))).bytes.toString('utf8');
      expect(text).toContain('"created_at","actor_id"');
      expect(text).toContain('report.requested');
      // The payload is JSON in one cell, quotes doubled — not split across three.
      expect(text).toMatch(/"\{""kind"":""AUDIT""/);
    });

    /**
     * An audit export is a file of what people did, and `before`/`after` are
     * redacted when the row is written. This pins that the export adds nothing:
     * a password hash reaching a spreadsheet would be a breach with a paper
     * trail attached.
     */
    it('carries nothing the audit row did not already carry', async () => {
      const view = await reports.request(
        { kind: ReportKind.AUDIT, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);
      const text = (await reports.download(view.id, ADMIN(admin.userId))).bytes.toString('utf8');

      const rows = await prisma.auditLog.findMany();
      const stored = JSON.stringify(rows.map((row) => [row.before, row.after]));
      expect(stored).not.toContain('passwordHash');
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('not-a-real-hash');
    });
  });

  describe('the firm boundary', () => {
    /**
     * The property the whole design is arranged around.
     *
     * The job payload carries an id and nothing else; the tenant is read from
     * the row and every query runs inside it. If that were wrong — a tenant in
     * the payload, a query outside the scope — this is the test that says so,
     * and it says so by reading the file rather than by inspecting the code.
     */
    it('puts only the requesting firm’s rows in the file', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      await withTenant(beta, () => ledgerEntry(betaAdmin.accountId, beta.tenantId, '999'));

      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);
      const text = (await reports.download(view.id, ADMIN(admin.userId))).bytes.toString('utf8');

      expect(text).toContain('"111"');
      expect(text, 'the other firm’s deposit is in the same table and the same window').not.toContain(
        '"999"',
      );
    });

    it('does not show one firm another firm’s reports', async () => {
      await reports.request({ kind: ReportKind.LEDGER, ...window() }, ADMIN(admin.userId));
      const mine = await reports.list();
      expect(mine).toHaveLength(1);

      const theirs = await withTenant(beta, () => reports.list());
      expect(theirs).toHaveLength(0);
    });

    it('does not let one firm download another firm’s file', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);

      await expect(
        withTenant(beta, () => reports.download(view.id, ADMIN(betaAdmin.userId))),
        'not-found rather than forbidden: a forbidden confirms the id exists',
      ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
    });
  });

  describe('who may have the file', () => {
    it('refuses somebody who did not ask for it, even in the same firm', async () => {
      const colleague = await createAccount(prisma, { email: 'other@alpha.test' });
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);

      await expect(reports.download(view.id, ADMIN(colleague.userId))).rejects.toMatchObject({
        code: TradingErrorCode.FORBIDDEN,
      });
    });

    /**
     * The check that is easy to leave out, and the reason this file exists.
     *
     * The report was requested by somebody who could read the book. By the time
     * they come back for the file they cannot. The row is evidence they were
     * once allowed; it is not a standing grant.
     */
    it('refuses the requester once their role can no longer read those rows', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);

      // Still theirs while the access holds.
      await expect(reports.download(view.id, ADMIN(admin.userId))).resolves.toBeDefined();

      // Same person, same report, and the role no longer reads those rows.
      await narrowRole(UserRole.ADMIN);
      await expect(reports.download(view.id, ADMIN(admin.userId))).rejects.toMatchObject({
        code: TradingErrorCode.FORBIDDEN,
      });
    });

    it('says something useful about a report that is not finished', async () => {
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await expect(reports.download(view.id, ADMIN(admin.userId))).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });

    it('audits every download', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);
      await reports.download(view.id, ADMIN(admin.userId));

      const audit = await prisma.auditLog.findFirst({ where: { action: 'report.downloaded' } });
      expect(audit?.resourceId).toBe(view.id);
    });

    it('never puts the file bytes in a listing', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);

      const listed = await reports.list();
      expect(JSON.stringify(listed)).not.toContain('111');
      expect(listed[0]).not.toHaveProperty('content');
    });
  });


  /**
   * When a report stops, and what happens next.
   *
   * This suite exists because the service's own comment promised it. `request`
   * writes the row, commits, then publishes — and the comment justifying that
   * order says a failed publish "is visible on the screen as a report that
   * never started, and the sweep can re-queue it". There was no such sweep. A
   * promise in a comment is not a mechanism, and this is the mechanism.
   *
   * The RUNNING case is the sharper one. A worker killed mid-build leaves the
   * row claimed, and nothing can ever pick it up again — the claim is a
   * conditional update from QUEUED, so the mechanism that makes retries safe is
   * exactly what makes a dead claim permanent.
   */
  describe('when a report stops', () => {
    const HOUR = 3_600_000;

    async function stall(reportId: string, patch: Record<string, unknown>) {
      await prisma.report.update({ where: { id: reportId }, data: patch });
    }

    it('re-queues one that was never picked up', async () => {
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await stall(view.id, { requestedAt: new Date(Date.now() - 2 * HOUR) });

      const { release, failed } = await maintenance.recoverStalledReports();
      expect(release).toEqual([view.id]);
      expect(failed).toBe(0);
    });

    it('leaves a report alone that has only just been asked for', async () => {
      // The sweep runs on a schedule; it must not fight the worker for a job
      // that is a second old.
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      const { release } = await maintenance.recoverStalledReports();
      expect(release).not.toContain(view.id);
    });

    /**
     * The case that could not recover on its own.
     */
    it('releases one whose worker died mid-build, so it can be claimed again', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      // Claimed, then the process went away.
      await stall(view.id, {
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 2 * HOUR),
        requestedAt: new Date(Date.now() - 2 * HOUR),
      });

      // Before the sweep, the claim is permanent: a build finds nothing to take.
      expect(await build(view.id)).toBe('skipped');

      const { release } = await maintenance.recoverStalledReports();
      expect(release).toEqual([view.id]);

      // And now it builds, which is the whole point of releasing it.
      expect(await build(view.id)).toBe('built');
      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.status).toBe('READY');
    });

    it('gives up on one that is still unfinished long afterwards, in words', async () => {
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await stall(view.id, { requestedAt: new Date(Date.now() - 12 * HOUR) });

      const { failed, release } = await maintenance.recoverStalledReports();
      expect(failed).toBe(1);
      expect(release, 'a report given up on is not also re-queued').toEqual([]);

      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.status).toBe('FAILED');
      expect(row.error).toContain('Ask for it again');
      expect(row.error).not.toContain('undefined');
    });

    it('never touches a report that finished', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);
      // Old enough to be given up on, had it not finished.
      await stall(view.id, { requestedAt: new Date(Date.now() - 12 * HOUR) });

      const { release, failed } = await maintenance.recoverStalledReports();
      expect(release).toEqual([]);
      expect(failed).toBe(0);
      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.status, 'a finished report is not un-finished by a clock').toBe('READY');
    });

    it('clears the bytes of an expired report and keeps the record', async () => {
      await ledgerEntry(admin.accountId, alpha.tenantId, '111');
      const view = await reports.request(
        { kind: ReportKind.LEDGER, ...window() },
        ADMIN(admin.userId),
      );
      await build(view.id);
      await stall(view.id, { expiresAt: new Date(Date.now() - HOUR) });

      expect(await maintenance.purgeExpiredReports()).toBe(1);

      const row = await prisma.report.findFirstOrThrow({ where: { id: view.id } });
      expect(row.status).toBe('EXPIRED');
      expect(row.content).toBeNull();
      expect(row.purgedAt).not.toBeNull();
      // The record of what was produced outlives the file.
      expect(row.sha256).not.toBeNull();
      expect(row.rowCount).not.toBeNull();

      await expect(reports.download(view.id, ADMIN(admin.userId))).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });
  });
});