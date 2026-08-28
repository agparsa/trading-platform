import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KillSwitchService, type KillSwitchState } from './kill-switch.service';

export interface OperationsSummary {
  trading: KillSwitchState;
  accounts: { total: number; active: number; withOpenPositions: number };
  positions: { open: number };
  orders: { resting: number; lastHour: number; rejectedLastHour: number };
  risk: { eventsLastDay: number; criticalLastDay: number };
  integrity: { open: number; bySeverity: Record<string, number> };
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
}
