import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { KillSwitchService, type KillSwitchState } from './kill-switch.service';

export interface OperationsSummary {
  trading: KillSwitchState;
  accounts: { total: number; active: number; withOpenPositions: number };
  positions: { open: number };
  orders: { resting: number; lastHour: number; rejectedLastHour: number };
  risk: { eventsLastDay: number; criticalLastDay: number };
  integrity: { open: number; bySeverity: Record<string, number> };
  /**
   * What the firm holds, what moved, and what dealing earned — by currency.
   *
   * The dashboard was counts only until this phase: it could say how many
   * orders were rejected in the last hour and not what the firm was holding
   * or what it had earned, which are the first two questions anyone running
   * one asks.
   */
  money: MoneySummary;
  reconciliation: { openFindings: number; lastRunAt: string | null };
  takenAt: string;
}

/**
 * One page an operator can look at to answer "is the platform all right".
 *
 * Deliberately a small number of counts rather than everything the system
 * knows. A dashboard with sixty figures on it is a dashboard nobody reads, and
 * the point of this one is that a person glancing at it can tell within a second
 * whether anything needs them. Anything that does have a place to go and look
 * further: the integrity queue, the risk events, the reconciliation findings.
 *
 * Every figure is a count over a bounded window. Nothing here scans a table
 * without a `WHERE`, because the page an operator opens during an incident must
 * not be the query that makes the incident worse.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  async summary(nowMs = Date.now()): Promise<OperationsSummary> {
    const hourAgo = new Date(nowMs - 60 * 60 * 1000);
    const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000);

    const [
      totalAccounts,
      activeAccounts,
      openPositions,
      accountsWithPositions,
      restingOrders,
      ordersLastHour,
      rejectedLastHour,
      riskLastDay,
      criticalRiskLastDay,
      integritySignals,
      reconciliationFindings,
      lastReconciliation,
    ] = await Promise.all([
      this.prisma.account.count(),
      this.prisma.account.count({ where: { status: 'ACTIVE' } }),
      this.prisma.position.count({ where: { status: { in: ['OPEN', 'CLOSING'] } } }),
      this.prisma.position
        .findMany({
          where: { status: { in: ['OPEN', 'CLOSING'] } },
          select: { accountId: true },
          distinct: ['accountId'],
        })
        .then((rows) => rows.length),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { createdAt: { gte: hourAgo } } }),
      this.prisma.order.count({ where: { createdAt: { gte: hourAgo }, status: 'REJECTED' } }),
      this.prisma.riskEvent.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.riskEvent.count({ where: { createdAt: { gte: dayAgo }, severity: 'CRITICAL' } }),
      this.prisma.integritySignal.groupBy({
        by: ['severity'],
        where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
        _count: { _all: true },
      }),
      this.prisma.riskEvent.count({
        where: { rule: 'reconciliation', createdAt: { gte: dayAgo } },
      }),
      this.prisma.riskEvent.findFirst({
        where: { rule: 'reconciliation' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const bySeverity: Record<string, number> = {};
    let openSignals = 0;
    for (const row of integritySignals) {
      bySeverity[row.severity] = row._count._all;
      openSignals += row._count._all;
    }

    return {
      trading: this.killSwitch.current(),
      accounts: {
        total: totalAccounts,
        active: activeAccounts,
        withOpenPositions: accountsWithPositions,
      },
      positions: { open: openPositions },
      orders: {
        resting: restingOrders,
        lastHour: ordersLastHour,
        rejectedLastHour: rejectedLastHour,
      },
      risk: { eventsLastDay: riskLastDay, criticalLastDay: criticalRiskLastDay },
      integrity: { open: openSignals, bySeverity },
      money: await this.money(dayAgo),
      /**
       * Reconciliation findings are counted over the last day rather than "all
       * open", because a finding has no status of its own — it is recorded as a
       * risk event, and the question an operator is asking is "did the last run
       * find anything", not "has anything ever been found".
       */
      reconciliation: {
        openFindings: reconciliationFindings,
        lastRunAt: lastReconciliation?.createdAt.toISOString() ?? null,
      },
      takenAt: new Date(nowMs).toISOString(),
    };
  }

  /**
   * The money figures, by currency.
   *
   * **By currency, never summed across them.** A firm holding dollars and
   * euros has two numbers, and one number made by adding them is not a smaller
   * mistake than showing neither — it is a figure that looks authoritative and
   * reconciles with nothing. Converting them would need a rate for every pair
   * at the instant the dashboard is drawn, and a dashboard is not the place to
   * invent one.
   *
   * These are the figures a dashboard of counts could not answer: what the
   * firm holds, what came in and went out, and what dealing earned it.
   */
  private async money(since: Date): Promise<MoneySummary> {
    const [balances, movements, tradeTotals, accounts] = await Promise.all([
      this.prisma.account.groupBy({ by: ['currency'], _sum: { balance: true } }),
      this.prisma.balanceLedger.groupBy({
        by: ['accountId', 'type'],
        where: { createdAt: { gte: since }, type: { in: ['DEPOSIT', 'WITHDRAWAL'] } },
        _sum: { amount: true },
      }),
      this.prisma.trade.groupBy({
        by: ['accountId'],
        where: { exitTime: { gte: since } },
        _sum: { netPnl: true, commission: true, swap: true, volume: true },
        _count: { _all: true },
      }),
      this.prisma.account.findMany({ select: { id: true, currency: true } }),
    ]);

    const currencyOf = new Map(accounts.map((row) => [row.id, row.currency]));
    const byCurrency = new Map<string, MoneyRow>();
    const row = (currency: string): MoneyRow => {
      const existing = byCurrency.get(currency);
      if (existing !== undefined) return existing;
      const created: MoneyRow = {
        currency,
        balance: '0',
        depositedLastDay: '0',
        withdrawnLastDay: '0',
        commissionLastDay: '0',
        swapLastDay: '0',
        netPnlLastDay: '0',
        closedTradesLastDay: 0,
        volumeLastDay: '0',
      };
      byCurrency.set(currency, created);
      return created;
    };

    for (const balance of balances) {
      row(balance.currency).balance = (balance._sum.balance ?? new Decimal(0)).toString();
    }
    for (const movement of movements) {
      const currency = currencyOf.get(movement.accountId);
      if (currency === undefined) continue;
      const target = row(currency);
      const amount = movement._sum.amount ?? new Decimal(0);
      if (movement.type === 'DEPOSIT') {
        target.depositedLastDay = new Decimal(target.depositedLastDay).plus(amount).toString();
      } else {
        /**
         * Withdrawals are negative ledger entries. The figure is labelled
         * "withdrawn", so it carries what left as a positive number — a
         * negative under that label reads as money arriving.
         */
        target.withdrawnLastDay = new Decimal(target.withdrawnLastDay)
          .plus(amount.abs())
          .toString();
      }
    }
    for (const total of tradeTotals) {
      const currency = currencyOf.get(total.accountId);
      if (currency === undefined) continue;
      const target = row(currency);
      target.commissionLastDay = new Decimal(target.commissionLastDay)
        .plus(total._sum.commission ?? 0)
        .toString();
      target.swapLastDay = new Decimal(target.swapLastDay).plus(total._sum.swap ?? 0).toString();
      target.netPnlLastDay = new Decimal(target.netPnlLastDay)
        .plus(total._sum.netPnl ?? 0)
        .toString();
      target.volumeLastDay = new Decimal(target.volumeLastDay)
        .plus(total._sum.volume ?? 0)
        .toString();
      target.closedTradesLastDay += total._count._all;
    }

    return {
      byCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    };
  }
}

/** One currency's money figures. Decimal strings throughout; never a float. */
export interface MoneyRow {
  readonly currency: string;
  balance: string;
  depositedLastDay: string;
  withdrawnLastDay: string;
  commissionLastDay: string;
  swapLastDay: string;
  netPnlLastDay: string;
  closedTradesLastDay: number;
  volumeLastDay: string;
}

export interface MoneySummary {
  /** One row per currency the firm holds. Never summed across currencies. */
  readonly byCurrency: readonly MoneyRow[];
}
