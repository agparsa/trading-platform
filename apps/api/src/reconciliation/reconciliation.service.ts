import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuePublisher } from '../jobs/queue-publisher.service';
import { QueueName } from '../jobs/queues';
import { requireTenantId } from '@tp/tenancy';

/**
 * Reading reconciliation, and deciding what to do about it.
 *
 * The checks themselves run in the worker — one process, on a schedule, holding
 * no locks against live trading. This is the half a person interacts with: what
 * was found, how long it has been true, and what somebody decided about it.
 *
 * ## Nothing here repairs anything
 *
 * Not one method writes to an account, a position, a trade or the ledger.
 * Correcting a discrepancy is a deliberate, separate, audited act — a ledger
 * adjustment through `AdjustmentsService`, with a reason and a second factor —
 * and keeping the two apart is what stops "resolve" from quietly becoming
 * "make it go away".
 *
 * Marking a finding RESOLVED says *a person looked and it is dealt with*. If
 * the drift is still there, the next run reopens it, which is the design: a tick
 * put there in good faith cannot hide a real inconsistency for longer than one
 * scheduled run.
 */
@Injectable()
export class ReconciliationReadService {
  private readonly logger = new Logger(ReconciliationReadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuePublisher,
  ) {}

  /** Recent runs, newest first. Includes clean ones — that is the point of them. */
  async runs(limit = 50): Promise<RunRow[]> {
    const rows = await this.prisma.reconciliationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      requestedByUserId: row.requestedByUserId,
      accountsChecked: row.accountsChecked,
      findingsRaised: row.findingsRaised,
      findingsRecurred: row.findingsRecurred,
      criticalCount: row.criticalCount,
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
    }));
  }

  async findings(query: {
    status?: string;
    severity?: string;
    accountId?: string;
    limit?: number;
  }): Promise<FindingRow[]> {
    const where: Prisma.ReconciliationFindingWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status as Prisma.ReconciliationFindingWhereInput['status'];
    }
    if (query.severity !== undefined) where.severity = query.severity;
    if (query.accountId !== undefined) where.accountId = query.accountId;

    const rows = await this.prisma.reconciliationFinding.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { lastSeenAt: 'desc' }],
      take: Math.min(Math.max(query.limit ?? 100, 1), 500),
      include: { account: { select: { number: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      accountId: row.accountId,
      accountNumber: row.account.number,
      code: row.code,
      severity: row.severity,
      status: row.status,
      expected: row.expected,
      actual: row.actual,
      difference: row.difference,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      message: row.message,
      occurrences: row.occurrences,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolutionNote: row.resolutionNote,
    }));
  }

  /**
   * Record what a person decided about a finding.
   *
   * The note is required for the two closing states and optional for the rest,
   * for the same reason the halt reason is: "why is this all right" is the
   * question asked afterwards, and an answer that lives in somebody's memory is
   * not an answer. Moving a finding to ACKNOWLEDGED needs no essay — it means "I
   * have seen it", which the actor and the timestamp already say.
   */
  async setFindingStatus(
    actorId: string,
    findingId: string,
    status: 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE',
    note: string | null,
  ): Promise<{ id: string; status: string }> {
    const closing = status === 'RESOLVED' || status === 'FALSE_POSITIVE';
    if (closing && (note === null || note.trim().length < 8)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Closing a finding needs a note somebody can read back later — at least a short sentence.',
      );
    }

    const before = await this.prisma.reconciliationFinding.findUnique({
      where: { id: findingId },
      select: { status: true, code: true, accountId: true },
    });
    if (before === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such finding', { findingId });
    }

    await this.prisma.reconciliationFinding.update({
      where: { id: findingId },
      data: {
        status,
        resolutionNote: note?.trim() ?? null,
        ...(closing
          ? { resolvedAt: new Date(), resolvedByUserId: actorId }
          : { resolvedAt: null, resolvedByUserId: null }),
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'reconciliation.finding_status_changed',
      resourceType: 'reconciliation_finding',
      resourceId: findingId,
      before: { status: before.status },
      after: { status, note: note?.trim() ?? null, code: before.code },
    });

    return { id: findingId, status };
  }

  /**
   * Ask for a run.
   *
   * The row is created here and the job carries its id, so the console can show
   * a run that has been requested and not yet started — rather than a button
   * that appears to do nothing until the worker gets round to it.
   *
   * A run already in flight is not queued behind another. Two concurrent passes
   * over every account would double the read load to produce the same answer,
   * and the second would race the first for the same finding rows.
   */
  async requestRun(actorId: string): Promise<{ runId: string; alreadyRunning: boolean }> {
    const inFlight = await this.prisma.reconciliationRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });

    // A run stuck in RUNNING because the worker died must not block every
    // future run for ever. After an hour it is not in flight, it is abandoned.
    const STALE_AFTER_MS = 60 * 60 * 1000;
    if (inFlight !== null && Date.now() - inFlight.startedAt.getTime() < STALE_AFTER_MS) {
      return { runId: inFlight.id, alreadyRunning: true };
    }

    const run = await this.prisma.reconciliationRun.create({
      data: { tenantId: requireTenantId(), trigger: 'MANUAL', requestedByUserId: actorId },
    });

    await this.queues.publish(
      QueueName.RECONCILIATION,
      'manual',
      { runId: run.id },
      // The run id is the job id, so a retried request cannot queue it twice.
      `manual-${run.id}`,
    );

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'reconciliation.run_requested',
      resourceType: 'reconciliation_run',
      resourceId: run.id,
    });

    this.logger.log({ runId: run.id, actorId }, 'Reconciliation run requested');
    return { runId: run.id, alreadyRunning: false };
  }

  /**
   * Where this platform and a venue disagreed (§44).
   *
   * Only disagreements exist as rows. A caller asking for `MATCHED` gets an
   * empty list, and that is correct rather than surprising: the run's
   * `itemsMatched` is where that number lives.
   */
  async items(query: {
    runId?: string;
    accountId?: string;
    status?: string;
    subject?: string;
    limit?: number;
  }) {
    const rows = await this.prisma.reconciliationItem.findMany({
      where: {
        ...(query.runId === undefined ? {} : { runId: query.runId }),
        ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
        ...(query.status === undefined
          ? {}
          : { status: query.status as Prisma.EnumReconciliationItemStatusFilter['equals'] }),
        ...(query.subject === undefined
          ? {}
          : { subject: query.subject as Prisma.EnumReconciliationSubjectFilter['equals'] }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 200, 500),
      select: {
        id: true,
        runId: true,
        accountId: true,
        subject: true,
        key: true,
        status: true,
        field: true,
        internal: true,
        external: true,
        difference: true,
        tolerance: true,
        message: true,
        createdAt: true,
        account: { select: { number: true } },
        /**
         * Whether anybody has said anything about it yet. The decisions
         * themselves are a separate call — a list view needs to know "has this
         * been looked at", not the whole history of what people concluded.
         */
        _count: { select: { resolutions: true } },
      },
    });
    return rows.map(({ _count, account, ...row }) => ({
      ...row,
      accountNumber: account.number,
      resolutionCount: _count.resolutions,
    }));
  }

  /**
   * Every decision recorded about one discrepancy, oldest first.
   *
   * Oldest first on purpose: this is a history, and reading it in the order it
   * happened is the only way "accepted, then escalated when it grew" makes
   * sense. Newest-first would show the conclusion before the reasoning.
   */
  async resolutions(query: { itemId?: string; findingId?: string }) {
    if (query.itemId === undefined && query.findingId === undefined) return [];
    return this.prisma.resolutionRecord.findMany({
      where: {
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        ...(query.findingId === undefined ? {} : { findingId: query.findingId }),
      },
      orderBy: { decidedAt: 'asc' },
      select: {
        id: true,
        decision: true,
        note: true,
        decidedAt: true,
        decidedBy: { select: { id: true, email: true, displayName: true } },
      },
    });
  }
}

export interface RunRow {
  id: string;
  status: string;
  trigger: string;
  requestedByUserId: string | null;
  accountsChecked: number;
  findingsRaised: number;
  findingsRecurred: number;
  criticalCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface FindingRow {
  id: string;
  runId: string;
  accountId: string;
  accountNumber: string;
  code: string;
  severity: string;
  status: string;
  expected: string;
  actual: string;
  difference: string;
  subjectType: string | null;
  subjectId: string | null;
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;

}
