import { Injectable, Logger } from '@nestjs/common';
import { toDecimal } from '@tp/financial-core';
import {
  reconcileAccount,
  Severity,
  type AccountRecords,
  type AccountReport,
  type Finding,
  type LedgerTotals,
} from '@tp/reconciliation-core';
import { PrismaService } from '../prisma.service';

export interface ReconciliationSummary {
  readonly checked: number;
  readonly reports: readonly AccountReport[];
  readonly findings: number;
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

  async check(): Promise<ReconciliationSummary> {
    const accounts = await this.prisma.account.findMany({
      select: { id: true, number: true, balance: true, currency: true },
      orderBy: { createdAt: 'asc' },
    });

    const reports: AccountReport[] = [];
    let findings = 0;
    let critical = 0;

    for (const account of accounts) {
      const records = await this.loadRecords(account);
      const report = reconcileAccount(records);
      if (report.findings.length === 0) continue;

      reports.push(report);
      findings += report.findings.length;
      critical += report.findings.filter((f) => f.severity === Severity.CRITICAL).length;

      for (const found of report.findings) {
        await this.record(account.id, report.number, found);
      }
    }

    if (findings === 0) {
      this.logger.log(`Reconciliation clean: ${accounts.length} account(s) agree with themselves`);
    } else {
      this.logger.error(
        { accounts: reports.length, findings, critical },
        'RECONCILIATION MISMATCH: records disagree. Nothing has been corrected.',
      );
    }
    return { checked: accounts.length, reports, findings, critical };
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
  private async record(accountId: string, number: string, found: Finding): Promise<void> {
    this.logger.error(
      { accountId, number, ...found },
      `RECONCILIATION ${found.code}: ${found.message}`,
    );
    await this.prisma.riskEvent.create({
      data: {
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
  }
}
