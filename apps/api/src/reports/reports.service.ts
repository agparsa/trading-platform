import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ReportKind,
  definitionOf,
  explainWindow,
  isReportKind,
  readWindow,
  reportFilename,
} from '@tp/reports-core';
import { reportSealContext } from '@tp/crypto-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { RolesService } from '../permissions/roles.service';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { QueueName } from '../jobs/queues';
import { SecretBoxService } from '../common/crypto/crypto.module';

/**
 * The context a report seal is bound to, so a sealed file cannot be moved
 * between rows.
 *
 * One definition, in `sealed-columns.ts`, re-exported at both ends. It used to
 * be written out twice — here and in the worker — under a comment saying the
 * two must match, which is a hope rather than a mechanism.
 */
export { reportSealContext };

export interface ReportRequest {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly accountId?: string;
}

export interface ReportView {
  readonly id: string;
  readonly kind: ReportKind;
  readonly status: string;
  readonly title: string;
  readonly params: Record<string, unknown>;
  readonly requestedById: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly rowCount: number | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly error: string | null;
  readonly filename: string;
}

/**
 * Reports: asking for one, listing them, and fetching the file.
 *
 * Producing the file is the worker's job. This service is the part that decides
 * who may have one, and it is the part worth reading twice.
 *
 * ## A report must not read what its requester could not
 *
 * A report is a way of reading rows. If `reports.run` alone were enough to
 * export the firm's book, it would be a permission that quietly grants
 * `accounts.read_any` to anybody who has it — which is how a capability system
 * develops a hole that no single check looks wrong.
 *
 * So every kind names the permission its contents would have needed on screen,
 * and that permission is checked **twice**: when the report is requested, and
 * again when the file is fetched.
 *
 * The second check is the one that is easy to leave out, and it is the one that
 * matters. A file lives for days. A person's role can change in that time —
 * they move desks, they are demoted during an investigation, their elevated
 * access expires. Checking only at request time means the export they asked for
 * on Monday is still theirs to download on Friday, after the access it was
 * based on is gone. The row is evidence that they were once allowed; it is not
 * a standing grant.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(QueuePublisher) private readonly queue: QueuePublisher,
    @Inject(SecretBoxService) private readonly secrets: SecretBoxService,
  ) {}

  private async assertMayRead(kind: ReportKind, actor: { readonly role: string }): Promise<void> {
    const needed = definitionOf(kind).permission;
    const held = await this.roles.permissionsFor(actor.role);
    if (!held.has(needed)) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `A ${definitionOf(kind).title.toLowerCase()} report contains rows that need ` +
          `${needed}. Exporting is not a way around reading.`,
        { kind, needed },
      );
    }
  }

  async request(
    input: ReportRequest,
    actor: { readonly id: string; readonly role: string },
  ): Promise<ReportView> {
    if (!isReportKind(input.kind)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Not a report this platform produces: ${input.kind}`,
        { kind: input.kind },
      );
    }
    const kind: ReportKind = input.kind;
    await this.assertMayRead(kind, actor);

    const parsed = readWindow(input.from, input.to);
    if ('problem' in parsed) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, explainWindow(parsed.problem), {
        from: input.from,
        to: input.to,
      });
    }
    const { window } = parsed;

    const params: Record<string, unknown> = {
      fromMs: window.fromMs,
      toMs: window.toMs,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    };

    const report = await this.prisma.report.create({
      data: {
        tenantId: requireTenantId(),
        kind,
        status: 'QUEUED',
        params: params as Prisma.InputJsonValue,
        requestedById: actor.id,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorType: 'ADMIN',
      action: 'report.requested',
      resourceType: 'Report',
      resourceId: report.id,
      after: { kind, ...params },
    });

    /**
     * Published after the row is committed, not inside the transaction.
     *
     * The worker looks the report up by id, so a job that arrives before its
     * row would find nothing and fail. The other order — row first, job second
     * — can leave a QUEUED row with no job if the publish fails, and that is
     * the better failure: it is visible on the screen as a report that never
     * started. A job with no row is invisible.
     *
     * `MaintenanceService.recoverStalledReports` is what picks it up again.
     * That sentence was in this comment before the sweep existed, which is the
     * defect this codebase keeps finding in itself: a promise in a comment is
     * not a mechanism. It is one now, and `reports.test.ts` holds it to it.
     */
    try {
      await this.queue.publish(QueueName.REPORTS, 'build', { reportId: report.id });
    } catch (error) {
      this.logger.error(
        { err: error, reportId: report.id },
        'Report row written but the job was not queued; it will stay QUEUED until re-queued',
      );
    }

    return this.view(report);
  }

  /** The firm's reports, newest first. Rows only — never the bytes. */
  async list(limit = 50): Promise<readonly ReportView[]> {
    const rows = await this.prisma.report.findMany({
      orderBy: { requestedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: SUMMARY,
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * The file, if this person may still have it.
   *
   * Four refusals, in this order, and each is a different sentence because they
   * are different situations: it is not yours, you may no longer read this, it
   * is not finished, the bytes are gone.
   */
  async download(
    reportId: string,
    actor: { readonly id: string; readonly role: string },
  ): Promise<{ readonly filename: string; readonly bytes: Buffer }> {
    const report = await this.prisma.report.findFirst({ where: { id: reportId } });
    if (report === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such report', { reportId });
    }

    /**
     * Only the person who asked for it.
     *
     * Not a permission check — a report is somebody's own query, with their
     * filters in it, and sharing files between operators is a feature nobody
     * has asked for. If it is ever wanted it should be a deliberate grant with
     * its own audit line, not a side effect of holding `reports.run`.
     */
    if (report.requestedById !== actor.id) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'A report belongs to whoever asked for it. Ask for your own.',
        { reportId },
      );
    }

    // The second check. See the class comment: roles change, files persist.
    await this.assertMayRead(report.kind as ReportKind, actor);

    if (report.status !== 'READY' || report.content === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        report.status === 'EXPIRED'
          ? 'That report has been kept as long as reports are kept. Ask for it again.'
          : report.status === 'FAILED'
            ? `That report did not finish: ${report.error ?? 'no reason recorded'}`
            : 'That report is still being produced.',
        { reportId, status: report.status },
      );
    }

    const bytes = this.secrets.openBytes(Buffer.from(report.content), reportSealContext(report.id));

    /**
     * The hash, checked on the way out rather than trusted.
     *
     * It costs a hash of a file already in memory, and it is the difference
     * between "the bytes in this row are what we produced" being a claim and
     * being a check. A mismatch means something rewrote the row underneath the
     * seal, which is worth refusing loudly rather than handing to an operator
     * who would have no way to tell.
     */
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== report.sha256) {
      this.logger.error(
        { reportId: report.id, expected: report.sha256, actual: digest },
        'Report bytes do not match the hash recorded when they were written',
      );
      throw new DomainError(
        TradingErrorCode.INTERNAL_ERROR,
        'That report failed its integrity check and has not been served. This has been recorded.',
        { reportId },
      );
    }

    await this.audit.record({
      actorId: actor.id,
      actorType: 'ADMIN',
      action: 'report.downloaded',
      resourceType: 'Report',
      resourceId: report.id,
      after: { kind: report.kind, sizeBytes: report.sizeBytes, rowCount: report.rowCount },
    });

    const params = report.params as { fromMs: number; toMs: number };
    return {
      filename: reportFilename(report.kind as ReportKind, params),
      bytes,
    };
  }

  private view(row: {
    id: string;
    kind: string;
    status: string;
    params: unknown;
    requestedById: string;
    requestedAt: Date;
    completedAt: Date | null;
    expiresAt: Date | null;
    rowCount: number | null;
    sizeBytes: number | null;
    sha256: string | null;
    error: string | null;
  }): ReportView {
    const kind = row.kind as ReportKind;
    const params = (row.params ?? {}) as { fromMs: number; toMs: number };
    return {
      id: row.id,
      kind,
      status: row.status,
      title: definitionOf(kind).title,
      params: params as unknown as Record<string, unknown>,
      requestedById: row.requestedById,
      requestedAt: row.requestedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      rowCount: row.rowCount,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      error: row.error,
      filename: reportFilename(kind, params),
    };
  }
}

/** Every column except `content`. A list must never load the files. */
const SUMMARY = {
  id: true,
  kind: true,
  status: true,
  params: true,
  requestedById: true,
  requestedAt: true,
  completedAt: true,
  expiresAt: true,
  rowCount: true,
  sizeBytes: true,
  sha256: true,
  error: true,
} as const;
