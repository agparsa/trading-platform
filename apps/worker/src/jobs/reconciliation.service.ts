import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import { PlatformEvent } from '@tp/shared-types';
import {
  reconcileAccount,
  Severity,
  type AccountRecords,
  type AccountReport,
  type Finding,
  type LedgerTotals,
} from '@tp/reconciliation-core';
import { PrismaService } from '../prisma.service';
import { withTenant, withoutTenantScope, type TenantContext } from '@tp/tenancy';

export interface ReconciliationSummary {
  readonly runId: string;
  readonly checked: number;
  readonly reports: readonly AccountReport[];
  readonly findings: number;
  /** Findings seen for the first time in this run. */
  readonly raised: number;
  /** Findings that were already on record and are still there. */
  readonly recurred: number;
  readonly critical: number;
}

/**
 * Compares the system's records against each other, account by account.
 *
 * Four tables record the same events from different angles — orders and their
 * executions, positions, closed trades, and the ledger. Each is written by its
 * own code path inside the same transaction, which is what makes them agree; if
 * they ever stop agreeing, exactly one of those paths is wrong and the others
 * are the evidence of it.
 *
 * **Nothing here repairs anything.** A discrepancy is detected, recorded and
 * alerted; correcting it is a deliberate, separate, audited act by a person.
 * Auto-correcting would erase the evidence of how the drift happened, which is
 * the one thing an investigation needs — and would turn a bug that shows up once
 * into a bug that quietly cleans up after itself for ever.
 *
 * The arithmetic lives in `@tp/reconciliation-core`, tested against fixtures
 * with a cent deliberately wrong in them. This class only fetches.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run the checks over every account, and record the run itself.
   *
   * The run row is written *before* the work starts and closed when it ends,
   * including when it fails. That ordering matters: "the last run was clean" and
   * "there has been no run since Tuesday" look identical if only findings are
   * stored, and only one of them is reassuring. An operator opening the console
   * during an incident needs to be able to tell them apart at a glance.
   *
   * `runId` may be supplied when a person asked for the run through the API and
   * the row already exists; otherwise one is created here.
   */
  async check(
    options: {
      runId?: string;
      trigger?: string;
      requestedByUserId?: string;
      /**
       * Restricts the sweep to one tenant.
       *
       * Absent means every tenant, which is what the scheduled run does: a
       * reconciliation that only checked the tenant that happened to ask for it
       * would leave every other one unchecked, and nobody would notice because
       * the run would report itself clean.
       */
      tenantId?: string;
    } = {},
  ): Promise<ReconciliationSummary> {
    const startedAt = Date.now();
    /**
     * A sweep across tenants still has to file its run row under one of them.
     *
     * The alternative — a nullable `tenantId` on `ReconciliationRun` — would
     * mean the one table an operator reads during an incident is the one table
     * with a special case in its scoping. So a scheduled sweep is recorded
     * against the platform's default tenant, and a run somebody asked for is
     * recorded against theirs.
     *
     * And it is written *inside* that tenant's scope. A queue hands this job
     * nothing — no request, no tenant — and a row carrying a `tenantId` is
     * still refused by the extension when no scope is open. That is the
     * extension doing its job, and it cost every scheduled run for weeks:
     * five refused attempts an hour, on schedule, and a console that showed
     * no run since the day tenancy went live. Every test had driven this from
     * inside a scope the harness opened.
     */
    const runTenant = await this.runTenant(options);
    const run = await withTenant(runTenant, () =>
      options.runId === undefined
        ? this.prisma.reconciliationRun.create({
            data: {
              tenantId: runTenant.tenantId,
              trigger: options.trigger ?? 'SCHEDULED',
              requestedByUserId: options.requestedByUserId ?? null,
            },
          })
        : this.prisma.reconciliationRun.update({
            where: { id: options.runId },
            data: { status: 'RUNNING', startedAt: new Date() },
          }),
    );

    try {
      /**
       * Read across every tenant, and say so.
       *
       * A sweep that only checked the tenant that happened to ask for it would
       * leave every other one unchecked and report itself clean, which is worse
       * than not running. `withoutTenantScope` is the one call that makes this
       * legitimate rather than a leak, and it takes a reason so that grepping
       * for every crossing of the boundary turns up an argument rather than a
       * shrug.
       */
      const accounts = await withoutTenantScope(
        'reconciliation sweeps every tenant; a per-tenant run would report itself clean',
        () =>
          this.prisma.account.findMany({
            where: options.tenantId === undefined ? {} : { tenantId: options.tenantId },
            select: { id: true, number: true, balance: true, currency: true, tenantId: true },
            orderBy: { createdAt: 'asc' },
          }),
      );
      // `Tenant` is not a scoped model; the slugs are for the scope each
      // account's checking runs in, so a log line names a firm, not a uuid.
      const slugs = new Map(
        (await this.prisma.tenant.findMany({ select: { id: true, slug: true } })).map((row) => [
          row.id,
          row.slug,
        ]),
      );

      const reports: AccountReport[] = [];
      let findings = 0;
      let raised = 0;
      let recurred = 0;
      let critical = 0;

      for (const account of accounts) {
        /**
         * Each account's work runs inside its own tenant's scope.
         *
         * The sweep crosses tenants; the *checking* does not. So every read of
         * this account's trades, executions and ledger is scoped, and a bug in
         * one of those queries cannot quietly pull in another firm's rows and
         * report the difference as a discrepancy.
         */
        const outcome = await withTenant(
          { tenantId: account.tenantId, slug: slugs.get(account.tenantId) ?? account.tenantId },
          async () => {
            const records = await this.loadRecords(account);
            const report = reconcileAccount(records);
            if (report.findings.length === 0) return null;

            let localRaised = 0;
            let localRecurred = 0;
            for (const found of report.findings) {
              const written = await this.record(
                run.id,
                account.id,
                account.tenantId,
                report.number,
                found,
              );
              if (written === 'raised') localRaised += 1;
              else localRecurred += 1;
            }
            return { report, localRaised, localRecurred };
          },
        );
        if (outcome === null) continue;

        reports.push(outcome.report);
        findings += outcome.report.findings.length;
        critical += outcome.report.findings.filter((f) => f.severity === Severity.CRITICAL).length;
        raised += outcome.localRaised;
        recurred += outcome.localRecurred;
      }

      await withTenant(runTenant, () =>
        this.prisma.reconciliationRun.update({
          where: { id: run.id },
          data: {
            status: 'COMPLETED',
            accountsChecked: accounts.length,
            findingsRaised: raised,
            findingsRecurred: recurred,
            criticalCount: critical,
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
          },
        }),
      );

      if (findings === 0) {
        this.logger.log(
          `Reconciliation clean: ${accounts.length} account(s) agree with themselves`,
        );
      } else {
        this.logger.error(
          { accounts: reports.length, findings, raised, recurred, critical },
          'RECONCILIATION MISMATCH: records disagree. Nothing has been corrected.',
        );
      }

      return {
        runId: run.id,
        checked: accounts.length,
        reports,
        findings,
        raised,
        recurred,
        critical,
      };
    } catch (error) {
      /**
       * A run that failed is not a run that found nothing.
       *
       * Recording the failure is what stops a broken job from looking like a
       * clean bill of health — the worst possible confusion for a check whose
       * whole purpose is to notice that something is wrong.
       */
      await withTenant(runTenant, () =>
        this.prisma.reconciliationRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            error: error instanceof Error ? error.message : String(error),
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
          },
        }),
      );
      throw error;
    }
  }

  /**
   * One account's records, at whatever moment the queries ran.
   *
   * Deliberately **not** wrapped in a transaction. A serializable read across
   * every table of a busy account would hold locks against live trading to
   * answer a question that is not urgent, and reconciliation must never block
   * order execution. The cost is that a trade committing mid-read can produce a
   * transient finding; the answer to that is to re-run, which is why this is
   * cheap and repeatable rather than exclusive.
   */
  private async loadRecords(account: {
    id: string;
    number: string;
    balance: { toString(): string };
    currency: string;
  }): Promise<AccountRecords> {
    const [orders, positions, trades, ledger, tradeReferences] = await Promise.all([
      this.prisma.order.findMany({
        where: { accountId: account.id },
        select: {
          id: true,
          status: true,
          volume: true,
          filledVolume: true,
          positionId: true,
          _count: { select: { executions: true } },
        },
      }),
      this.prisma.position.findMany({
        where: { accountId: account.id },
        select: {
          id: true,
          status: true,
          side: true,
          volume: true,
          initialVolume: true,
          commission: true,
          swap: true,
          realizedPnl: true,
          orders: {
            select: {
              side: true,
              executions: { select: { side: true, volume: true } },
            },
          },
        },
      }),
      this.prisma.trade.findMany({
        where: { accountId: account.id },
        select: {
          id: true,
          positionId: true,
          grossPnl: true,
          commission: true,
          entryCommission: true,
          exitCommission: true,
          swap: true,
          netPnl: true,
        },
      }),
      this.ledgerTotals(account.id),
      this.prisma.balanceLedger.groupBy({
        by: ['referenceId'],
        where: { accountId: account.id, referenceType: 'Position' },
        _count: { _all: true },
      }),
    ]);

    const entriesByPosition = new Map(
      tradeReferences
        .filter((row): row is typeof row & { referenceId: string } => row.referenceId !== null)
        .map((row) => [row.referenceId, row._count._all]),
    );

    return {
      accountId: account.id,
      number: account.number,
      currency: account.currency,
      storedBalance: account.balance.toString(),
      ledger,
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        volume: order.volume.toString(),
        filledVolume: order.filledVolume.toString(),
        positionId: order.positionId,
        executionCount: order._count.executions,
      })),
      positions: positions.map((position) => {
        /**
         * An execution opens the position when it is on the position's own
         * side, and closes it when it is on the other. The closing order is
         * created with the opposite side by `performClose`, so this is the same
         * distinction the engine itself makes rather than a second reading of
         * it.
         */
        let opened = toDecimal(0);
        let closed = toDecimal(0);
        for (const order of position.orders) {
          for (const execution of order.executions) {
            const volume = toDecimal(execution.volume.toString());
            if (execution.side === position.side) opened = opened.plus(volume);
            else closed = closed.plus(volume);
          }
        }
        return {
          id: position.id,
          status: position.status,
          volume: position.volume.toString(),
          initialVolume: position.initialVolume.toString(),
          commission: position.commission.toString(),
          swap: position.swap.toString(),
          realizedPnl: position.realizedPnl.toString(),
          openingExecutedVolume: opened.toString(),
          closingExecutedVolume: closed.toString(),
        };
      }),
      trades: trades.map((trade) => ({
        id: trade.id,
        positionId: trade.positionId,
        grossPnl: trade.grossPnl.toString(),
        commission: trade.commission.toString(),
        entryCommission: trade.entryCommission.toString(),
        exitCommission: trade.exitCommission.toString(),
        swap: trade.swap.toString(),
        netPnl: trade.netPnl.toString(),
        ledgerEntryCount: entriesByPosition.get(trade.positionId) ?? 0,
      })),
    };
  }

  /**
   * The ledger, summed by kind, in the database rather than in this process.
   *
   * An account with years of entries should not have every one of them cross the
   * wire so that JavaScript can add them up. `SUM` over `NUMERIC` is exact in
   * PostgreSQL — this is the one place summing money outside `Decimal` is safe,
   * because it never leaves the database's own numeric type.
   */
  private async ledgerTotals(accountId: string): Promise<LedgerTotals> {
    const rows = await this.prisma.$queryRaw<
      Array<{ all: string; trade_result: string; commission: string; swap: string }>
    >`
      SELECT
        COALESCE(SUM(amount), 0)::text AS all,
        COALESCE(SUM(amount) FILTER (WHERE type IN ('TRADE_PROFIT', 'TRADE_LOSS')), 0)::text
          AS trade_result,
        COALESCE(SUM(amount) FILTER (WHERE type = 'COMMISSION'), 0)::text AS commission,
        COALESCE(SUM(amount) FILTER (WHERE type = 'SWAP'), 0)::text AS swap
      FROM balance_ledger
      WHERE account_id = ${accountId}::uuid
    `;
    const row = rows[0];
    return {
      all: row?.all ?? '0',
      tradeResult: row?.trade_result ?? '0',
      commission: row?.commission ?? '0',
      swap: row?.swap ?? '0',
    };
  }

  /**
   * DETECTED → RECORDED → ALERTED. The next two steps belong to a person.
   *
   * Recorded as a `RiskEvent` because that is where this platform already keeps
   * "the engine noticed something about this account", and an investigator
   * should find a reconciliation mismatch in the same place as a margin breach
   * rather than in a table they have to be told about.
   */
  /**
   * Record one finding, or note that it is still there.
   *
   * One row per (account, code, subject): a drift that is still present on the
   * next run is the same drift seen again, not a second one. A thousand
   * duplicate rows would bury the one fact an investigator wants, which is *how
   * long this has been true*.
   *
   * A finding that had been marked RESOLVED and has come back is **reopened**,
   * with the resolution cleared. Leaving it closed would let a real
   * inconsistency sit behind a tick somebody put there in good faith when it had
   * genuinely gone away.
   */
  /**
   * The tenant this run's row belongs to, and so the scope its writes need.
   *
   * A run a person asked for already has a row, created by the API in their
   * tenant; it is found across tenants because nothing here knows which one
   * yet. A run for one tenant is theirs. A platform-wide sweep files under the
   * oldest tenant — looked up rather than configured: a constant would be a
   * second place the default tenant's identity is written down, and the two
   * would disagree the first time somebody renamed it.
   */
  private async runTenant(options: { runId?: string; tenantId?: string }): Promise<TenantContext> {
    // `Tenant` is not a scoped model, so its reads need no scope of their own.
    if (options.runId !== undefined) {
      const runId = options.runId;
      const existing = await withoutTenantScope(
        'a requested run was filed by the API in its tenant; the job has to find which',
        () =>
          this.prisma.reconciliationRun.findUnique({
            where: { id: runId },
            select: { tenant: { select: { id: true, slug: true } } },
          }),
      );
      if (existing === null) {
        throw new Error(`Reconciliation run ${runId} does not exist.`);
      }
      return { tenantId: existing.tenant.id, slug: existing.tenant.slug };
    }
    const tenant =
      options.tenantId === undefined
        ? await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } })
        : await this.prisma.tenant.findUnique({ where: { id: options.tenantId } });
    if (tenant === null) {
      throw new Error(
        options.tenantId === undefined
          ? 'Reconciliation cannot run: the platform has no tenants.'
          : `Reconciliation cannot run: no tenant has the id ${options.tenantId}.`,
      );
    }
    return { tenantId: tenant.id, slug: tenant.slug };
  }

  private async record(
    runId: string,
    accountId: string,
    tenantId: string,
    number: string,
    found: Finding,
  ): Promise<'raised' | 'recurred'> {
    this.logger.error(
      { accountId, number, ...found },
      `RECONCILIATION ${found.code}: ${found.message}`,
    );

    const subjectKey = found.subjectId ?? '';
    const now = new Date();

    const existing = await this.prisma.reconciliationFinding.findUnique({
      where: { accountId_code_subjectKey: { accountId, code: found.code, subjectKey } },
      select: { id: true, status: true },
    });

    const evidence = {
      expected: found.expected,
      actual: found.actual,
      difference: found.difference,
      message: found.message,
      severity: found.severity,
    };

    const reopening =
      existing !== null && (existing.status === 'RESOLVED' || existing.status === 'FALSE_POSITIVE');

    /**
     * The three writes are one transaction.
     *
     * They were three statements in a row until the outbox joined them, and
     * that arrangement had a hole the moment anything downstream depended on
     * the event: if the finding committed and the outbox row did not, the next
     * sweep would see the finding already on record, call it a recurrence, and
     * send nothing — an alert lost for good rather than late. The outbox's
     * whole discipline is that the event commits with the change it describes.
     */
    await this.prisma.$transaction(async (tx) => {
      if (existing === null) {
        await tx.reconciliationFinding.create({
          data: {
            tenantId,
            runId,
            accountId,
            code: found.code,
            subjectKey,
            subjectType: found.subjectType ?? null,
            subjectId: found.subjectId ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
            ...evidence,
          },
        });
      } else {
        await tx.reconciliationFinding.update({
          where: { id: existing.id },
          data: {
            runId,
            lastSeenAt: now,
            occurrences: { increment: 1 },
            ...evidence,
            ...(reopening
              ? { status: 'OPEN', resolvedAt: null, resolvedByUserId: null, resolutionNote: null }
              : {}),
          },
        });
      }

      /**
       * Still written as a risk event.
       *
       * The findings table is the record an investigator works from; the risk
       * event stream is what the operations summary and any alerting already
       * watch. Removing this would silence an alert that exists, to gain
       * nothing.
       */
      await tx.riskEvent.create({
        data: {
          tenantId,
          accountId,
          rule: 'reconciliation',
          code: found.code,
          severity: found.severity,
          message: found.message,
          snapshot: {
            expected: found.expected,
            actual: found.actual,
            difference: found.difference,
            ...(found.subjectType === undefined ? {} : { subjectType: found.subjectType }),
            ...(found.subjectId === undefined ? {} : { subjectId: found.subjectId }),
          },
        },
      });

      /**
       * And told to the firm, once (§49).
       *
       * A finding raised for the first time is news; one that had been closed
       * and has come back is news again, and arguably worse, because somebody
       * decided it had gone away. A finding that is simply still there is not:
       * an hourly sweep would send the same fact seven hundred times in a
       * month, the receiver would filter the type, and the next real
       * discrepancy would arrive into a filter.
       *
       * `occurrences` is in the payload so a receiver can see at a glance
       * whether this is a first sighting or a relapse, without asking.
       */
      if (existing !== null && !reopening) return;
      await tx.outboxEvent.create({
        data: {
          tenantId,
          eventId: randomUUID(),
          eventType: PlatformEvent.RECONCILIATION_MISMATCH,
          aggregateType: 'account',
          aggregateId: accountId,
          accountId,
          // Nobody asked for this; the sweep noticed it.
          actorId: null,
          correlationId: runId,
          causationId: null,
          payload: {
            runId,
            accountId,
            accountNumber: number,
            code: found.code,
            severity: found.severity,
            message: found.message,
            expected: found.expected,
            actual: found.actual,
            difference: found.difference,
            subjectType: found.subjectType ?? null,
            subjectId: found.subjectId ?? null,
            reopened: reopening,
            detectedAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    });

    if (reopening) {
      this.logger.error(
        { accountId, code: found.code, subjectKey },
        'A reconciliation finding that had been closed has come back; it is open again',
      );
    }

    return existing === null ? 'raised' : 'recurred';
  }
}
