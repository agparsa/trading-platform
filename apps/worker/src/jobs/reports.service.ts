import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { SecretBox, parseEncryptionKeys, reportSealContext } from '@tp/crypto-core';
import { MAX_REPORT_ROWS, ReportKind, UTF8_BOM, csvRow, definitionOf } from '@tp/reports-core';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma.service';
import type { WorkerEnv } from '../env';

/**
 * The context a report seal is bound to, so a sealed file cannot be moved
 * between rows.
 *
 * One definition, in `sealed-columns.ts`, re-exported at both ends. It used to
 * be written out twice — here and in the worker — under a comment saying the
 * two must match, which is a hope rather than a mechanism.
 */
export { reportSealContext };

/** Rows are fetched in pages, so one report is not one enormous result set. */
const PAGE = 5_000;

interface ReportRow {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly status: string;
  readonly params: unknown;
}

/**
 * Producing a report: query, CSV, seal, store.
 *
 * ## Why this is a job and not a request
 *
 * The panel's export buttons write out the page on screen. That is honest for a
 * hundred rows and useless for a quarter — an operator asking for "every closed
 * trade in March" got the fifty rows the table had paged in. A real export is
 * minutes of query and megabytes of output, which is not something an HTTP
 * request should hold open, and is something somebody wants to come back for.
 *
 * ## The tenant, taken from the row and not from the job
 *
 * The job carries a report id and nothing else. The tenant comes from the row,
 * and every query runs inside `withTenant` for that firm — so a report of firm
 * A's trades is built by a worker that can only see firm A, and the Prisma
 * extension and row-level security both apply exactly as they do in a request.
 * Putting the tenant in the job payload would have made the queue a place where
 * a wrong value becomes a cross-firm read.
 *
 * ## A retry must not produce two files
 *
 * BullMQ retries. The claim is a conditional update from QUEUED to RUNNING: the
 * job that changes the row is the job that builds the file, and a second
 * attempt finds nothing to claim and stops. A report already READY is likewise
 * left alone rather than rebuilt — the file somebody downloaded must not change
 * underneath them.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private box: SecretBox | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnv, true>,
    @Optional() secrets?: SecretBox,
  ) {
    this.box = secrets ?? null;
  }

  private secrets(): SecretBox | null {
    if (this.box !== null) return this.box;
    const keys = this.config.get('SECRET_ENCRYPTION_KEYS', { infer: true });
    if (keys === undefined || keys === '') return null;
    this.box = new SecretBox(parseEncryptionKeys(keys));
    return this.box;
  }

  private retentionDays(): number {
    const raw = Number(
      (this.config.get as (key: string) => unknown)('REPORT_RETENTION_DAYS') ?? 14,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 14;
  }

  async build(reportId: string, now: Date = new Date()): Promise<'built' | 'skipped' | 'failed'> {
    const report = await withoutTenantScope(
      'a report job knows only an id; the firm is read from the row',
      () =>
        this.prisma.report.findUnique({
          where: { id: reportId },
          select: { id: true, tenantId: true, kind: true, status: true, params: true },
        }) as Promise<ReportRow | null>,
    );
    if (report === null) {
      this.logger.warn({ reportId }, 'Report job for a row that does not exist');
      return 'skipped';
    }

    const scope = { tenantId: report.tenantId, slug: report.tenantId };

    /**
     * Claim it, or leave it to whoever did.
     *
     * `updateMany` with the status in the `where` is the whole concurrency
     * story: exactly one attempt moves QUEUED to RUNNING, and the others see
     * zero rows changed and stop. No lock, no leader, and correct under a
     * retry, a duplicate publish, and two workers racing.
     */
    const claimed = await withTenant(scope, () =>
      this.prisma.report.updateMany({
        where: { id: report.id, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt: now },
      }),
    );
    if (claimed.count === 0) {
      this.logger.log(
        { reportId, status: report.status },
        'Report already claimed; not rebuilding',
      );
      return 'skipped';
    }

    try {
      const box = this.secrets();
      if (box === null) {
        throw new Error('this worker cannot seal files (SECRET_ENCRYPTION_KEYS is not set)');
      }

      const kind = report.kind as ReportKind;
      const params = report.params as { fromMs: number; toMs: number; accountId?: string };
      const built = await withTenant(scope, () => this.rows(kind, params));

      const document = UTF8_BOM + [csvRow(definitionOf(kind).columns), ...built].join('\r\n');
      const bytes = Buffer.from(document, 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const sealed = box.sealBytes(bytes, reportSealContext(report.id));
      const expiresAt = new Date(now.getTime() + this.retentionDays() * 86_400_000);

      await withTenant(scope, () =>
        this.prisma.report.update({
          where: { id: report.id },
          data: {
            status: 'READY',
            // Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer; a
            // Buffer may sit on a SharedArrayBuffer. Same copy as kyc.service.
            content: new Uint8Array(sealed),
            sealedWithKeyId: box.activeKeyId,
            sha256,
            sizeBytes: bytes.length,
            rowCount: built.length,
            completedAt: now,
            expiresAt,
            error: null,
          },
        }),
      );
      this.logger.log(
        { reportId, kind, rows: built.length, sizeBytes: bytes.length },
        'Report built',
      );
      return 'built';
    } catch (error) {
      /**
       * The reason, in words, and never a stack trace.
       *
       * `error` is shown to an operator on the reports screen. A stack trace
       * there tells them nothing they can act on and tells anybody reading over
       * their shoulder the shape of the codebase.
       */
      const because =
        error instanceof Error && error.message.length > 0 ? error.message : 'no reason recorded';
      await withTenant(scope, () =>
        this.prisma.report.update({
          where: { id: report.id },
          data: { status: 'FAILED', error: because, completedAt: now },
        }),
      ).catch(() => undefined);
      this.logger.error({ err: error, reportId }, 'Report failed');
      return 'failed';
    }
  }

  /** Dispatch on kind. Every branch returns already-stringified CSV rows. */
  private async rows(
    kind: ReportKind,
    params: { fromMs: number; toMs: number; accountId?: string },
  ): Promise<string[]> {
    switch (kind) {
      case ReportKind.TRADES:
        return this.trades(params);
      case ReportKind.LEDGER:
        return this.ledger(params);
      case ReportKind.AUDIT:
        return this.audit(params);
      case ReportKind.ORDERS:
        return this.orders(params);
      case ReportKind.POSITIONS:
        return this.positions(params);
      default: {
        const never: never = kind;
        throw new Error(`no builder for report kind ${String(never)}`);
      }
    }
  }

  /**
   * Pages through a query, refusing rather than truncating at the cap.
   *
   * A truncated statement that does not say it is truncated is worse than no
   * statement: somebody reconciles against it and the difference is the rows
   * that were silently dropped.
   */
  private async paged<T>(
    fetch: (cursor: string | undefined) => Promise<T[]>,
    idOf: (row: T) => string,
    format: (row: T) => string[],
  ): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await fetch(cursor);
      for (const row of page) {
        if (out.length >= MAX_REPORT_ROWS) {
          throw new Error(
            `This window holds more than ${MAX_REPORT_ROWS.toLocaleString('en-GB')} rows, ` +
              `which is more than one report may contain. Ask for it in parts.`,
          );
        }
        out.push(csvRow(format(row)));
      }
      if (page.length < PAGE) return out;
      cursor = idOf(page[page.length - 1] as T);
    }
  }

  private async trades(params: {
    fromMs: number;
    toMs: number;
    accountId?: string;
  }): Promise<string[]> {
    const where = {
      exitTime: { gte: new Date(params.fromMs), lte: new Date(params.toMs) },
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    };
    return this.paged(
      (cursor) =>
        this.prisma.trade.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
          include: { account: { select: { number: true, currency: true } }, symbol: true },
        }) as Promise<TradeRow[]>,
      (row) => row.id,
      (row) => [
        row.id,
        row.account?.number ?? '',
        row.symbol?.code ?? '',
        row.side,
        row.volume.toString(),
        row.entryPrice.toString(),
        row.entryTime.toISOString(),
        row.exitPrice.toString(),
        row.exitTime.toISOString(),
        row.entryCommission.toString(),
        row.exitCommission.toString(),
        row.swap.toString(),
        row.grossPnl.toString(),
        row.netPnl.toString(),
        row.account?.currency ?? '',
        row.closeReason ?? '',
      ],
    );
  }

  /**
   * The audit trail.
   *
   * `accountId` is not a filter here and is deliberately ignored: an audit row
   * is about an *actor* and a *resource*, and most of them have no account at
   * all. Silently treating an account filter as a row filter would produce a
   * file that looks complete and is not — the failure this whole feature exists
   * to stop.
   *
   * `before` and `after` go out as JSON exactly as stored. They are redacted
   * when the row is written; redacting again here would make the file and the
   * audit screen disagree about what happened, which is the one thing an audit
   * export may not do.
   */
  private async audit(params: { fromMs: number; toMs: number }): Promise<string[]> {
    const where = { createdAt: { gte: new Date(params.fromMs), lte: new Date(params.toMs) } };
    return this.paged(
      (cursor) =>
        this.prisma.auditLog.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        }) as Promise<AuditRow[]>,
      (row) => row.id,
      (row) => [
        row.createdAt.toISOString(),
        row.actorId ?? '',
        row.actorType,
        row.action,
        row.resourceType,
        row.resourceId ?? '',
        row.requestId ?? '',
        row.ipAddress ?? '',
        JSON.stringify(row.before ?? null),
        JSON.stringify(row.after ?? null),
      ],
    );
  }

  /**
   * Orders placed in the window.
   *
   * `createdAt` is the window, and `kinds.ts` carries the argument for it: it
   * is the one timestamp on an order that never moves, so the same window
   * always selects the same rows. What those rows *say* can still change while
   * an order is resting, and the definition says that out loud rather than
   * leaving somebody to discover it by diffing two exports.
   *
   * Prices are nullable — a market order has no limit price, and only a stop
   * order has a stop price. They go out empty rather than as `0`, because a
   * zero in a price column is a price.
   */
  private async orders(params: {
    fromMs: number;
    toMs: number;
    accountId?: string;
  }): Promise<string[]> {
    const where = {
      createdAt: { gte: new Date(params.fromMs), lte: new Date(params.toMs) },
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    };
    return this.paged(
      (cursor) =>
        this.prisma.order.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
          include: { account: { select: { number: true } }, symbol: true },
        }) as Promise<OrderRow[]>,
      (row) => row.id,
      (row) => [
        row.id,
        row.account?.number ?? '',
        row.symbol?.code ?? '',
        row.side,
        row.type,
        row.status,
        row.timeInForce,
        row.volume.toString(),
        row.filledVolume.toString(),
        row.price?.toString() ?? '',
        row.stopPrice?.toString() ?? '',
        row.stopLoss?.toString() ?? '',
        row.takeProfit?.toString() ?? '',
        row.createdAt.toISOString(),
        row.updatedAt.toISOString(),
        row.expiresAt?.toISOString() ?? '',
        row.rejectionCode ?? '',
        row.positionId ?? '',
        row.clientOrderId ?? '',
        row.externalOrderId ?? '',
      ],
    );
  }

  /**
   * Positions opened in the window, whether or not they have closed.
   *
   * `openedAt` is the window, so a position opened in March and still open in
   * June is in a March report with its close columns empty. Windowing on
   * `closedAt` would have produced a tidier file that answered a different
   * question and gave no sign it had — see `kinds.ts`.
   *
   * There is no unrealized-profit column, and this builder does not compute
   * one. `currentPrice` is the last mark the engine recorded; multiplying it
   * out here would stamp a figure that is true at build time onto a file headed
   * with last month's dates. What goes out otherwise is what is settled about
   * the position: commission, swap, realized profit, and the margin held.
   */
  private async positions(params: {
    fromMs: number;
    toMs: number;
    accountId?: string;
  }): Promise<string[]> {
    const where = {
      openedAt: { gte: new Date(params.fromMs), lte: new Date(params.toMs) },
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    };
    return this.paged(
      (cursor) =>
        this.prisma.position.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
          include: { account: { select: { number: true, currency: true } }, symbol: true },
        }) as Promise<PositionRow[]>,
      (row) => row.id,
      (row) => [
        row.id,
        row.account?.number ?? '',
        row.symbol?.code ?? '',
        row.side,
        row.status,
        row.volume.toString(),
        row.initialVolume.toString(),
        row.entryPrice.toString(),
        row.currentPrice?.toString() ?? '',
        row.stopLoss?.toString() ?? '',
        row.takeProfit?.toString() ?? '',
        row.margin.toString(),
        row.commission.toString(),
        row.swap.toString(),
        row.realizedPnl.toString(),
        row.account?.currency ?? '',
        row.openedAt.toISOString(),
        row.closedAt?.toISOString() ?? '',
        row.closeReason ?? '',
        row.externalPositionId ?? '',
      ],
    );
  }

  private async ledger(params: {
    fromMs: number;
    toMs: number;
    accountId?: string;
  }): Promise<string[]> {
    const where = {
      createdAt: { gte: new Date(params.fromMs), lte: new Date(params.toMs) },
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    };
    return this.paged(
      (cursor) =>
        this.prisma.balanceLedger.findMany({
          where,
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
          include: { account: { select: { number: true } } },
        }) as Promise<LedgerRow[]>,
      (row) => row.id,
      (row) => [
        row.id,
        row.account?.number ?? '',
        row.createdAt.toISOString(),
        row.type,
        row.amount.toString(),
        row.balanceAfter.toString(),
        row.currency,
        row.referenceType ?? '',
        row.referenceId ?? '',
        row.description ?? '',
      ],
    );
  }
}

interface TradeRow {
  id: string;
  side: string;
  volume: { toString(): string };
  entryPrice: { toString(): string };
  entryTime: Date;
  exitPrice: { toString(): string };
  exitTime: Date;
  entryCommission: { toString(): string };
  exitCommission: { toString(): string };
  swap: { toString(): string };
  grossPnl: { toString(): string };
  netPnl: { toString(): string };
  closeReason: string | null;
  account: { number: string; currency: string } | null;
  symbol: { code: string } | null;
}

interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  before: unknown;
  after: unknown;
}

interface LedgerRow {
  id: string;
  createdAt: Date;
  type: string;
  amount: { toString(): string };
  balanceAfter: { toString(): string };
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  account: { number: string } | null;
}

interface OrderRow {
  id: string;
  side: string;
  type: string;
  status: string;
  timeInForce: string;
  volume: { toString(): string };
  filledVolume: { toString(): string };
  price: { toString(): string } | null;
  stopPrice: { toString(): string } | null;
  stopLoss: { toString(): string } | null;
  takeProfit: { toString(): string } | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  rejectionCode: string | null;
  positionId: string | null;
  clientOrderId: string | null;
  externalOrderId: string | null;
  account: { number: string } | null;
  symbol: { code: string } | null;
}

interface PositionRow {
  id: string;
  side: string;
  status: string;
  volume: { toString(): string };
  initialVolume: { toString(): string };
  entryPrice: { toString(): string };
  currentPrice: { toString(): string } | null;
  stopLoss: { toString(): string } | null;
  takeProfit: { toString(): string } | null;
  margin: { toString(): string };
  commission: { toString(): string };
  swap: { toString(): string };
  realizedPnl: { toString(): string };
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  externalPositionId: string | null;
  account: { number: string; currency: string } | null;
  symbol: { code: string } | null;
}
