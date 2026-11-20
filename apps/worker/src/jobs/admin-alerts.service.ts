import { Injectable, Logger } from '@nestjs/common';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import {
  breaches,
  isAdminAlertMetric,
  shouldRaise,
  type AdminAlertComparator,
  type AdminAlertMetric,
} from '@tp/shared-types';
import { PrismaService } from '../prisma.service';

export interface AdminAlertsSummary {
  readonly evaluated: number;
  readonly raised: number;
}

const HOUR = 3_600_000;

/**
 * Reads every enabled alert rule's metric and raises an alert when it
 * crosses its threshold.
 *
 * Discovery crosses firms — the sweep must find every firm's rules — and each
 * firm's rules are then read and written inside that firm's own scope, so a
 * count is always of that firm's rows and nobody else's. A rule whose metric
 * this version does not know is skipped and logged rather than read as zero,
 * which would be an alert that can never fire, or always does.
 */
@Injectable()
export class AdminAlertsService {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(now: Date = new Date()): Promise<AdminAlertsSummary> {
    const tenants = await withoutTenantScope(
      'the alert sweep must find every firm’s rules; each firm is then read in its own scope',
      () =>
        this.prisma.tenant.findMany({
          where: { adminAlertRules: { some: { enabled: true } } },
          select: { id: true, slug: true, kind: true },
        }),
    );
    let evaluated = 0;
    let raised = 0;
    for (const tenant of tenants) {
      try {
        const result = await withTenant(
          { tenantId: tenant.id, slug: tenant.slug, kind: tenant.kind },
          () => this.evaluateTenant(tenant.id, now),
        );
        evaluated += result.evaluated;
        raised += result.raised;
      } catch (error) {
        // One firm's failure is logged and does not stop the others being read.
        this.logger.error(
          { tenantId: tenant.id, err: error },
          'Admin alert rules could not be evaluated for a firm',
        );
      }
    }
    return { evaluated, raised };
  }

  private async evaluateTenant(tenantId: string, now: Date): Promise<AdminAlertsSummary> {
    const rules = await this.prisma.adminAlertRule.findMany({ where: { enabled: true } });
    const readings = new Map<AdminAlertMetric, number>();
    let raised = 0;
    for (const rule of rules) {
      if (!isAdminAlertMetric(rule.metric)) {
        this.logger.warn({ ruleId: rule.id, metric: rule.metric }, 'Unknown alert metric skipped');
        continue;
      }
      const value = readings.get(rule.metric) ?? (await this.read(rule.metric, now));
      readings.set(rule.metric, value);
      const comparator = rule.comparator as AdminAlertComparator;
      const breached = breaches(value, comparator, rule.threshold);
      const raise = shouldRaise({
        breached,
        wasBreached: rule.inBreach,
        lastRaisedAt: rule.lastRaisedAt,
        cooldownMinutes: rule.cooldownMinutes,
        now,
      });
      await this.prisma.$transaction(async (tx) => {
        await tx.adminAlertRule.update({
          where: { id: rule.id },
          data: {
            lastValue: value,
            lastEvaluatedAt: now,
            inBreach: breached,
            ...(raise ? { lastRaisedAt: now } : {}),
          },
        });
        if (raise) {
          await tx.adminAlert.create({
            data: {
              tenantId,
              ruleId: rule.id,
              ruleName: rule.name,
              metric: rule.metric,
              comparator: rule.comparator,
              threshold: rule.threshold,
              value,
              raisedAt: now,
            },
          });
        }
      });
      if (raise) {
        raised += 1;
        this.logger.warn(
          { tenantId, ruleId: rule.id, metric: rule.metric, value, threshold: rule.threshold },
          `Admin alert raised: ${rule.name}`,
        );
      }
    }
    return { evaluated: rules.length, raised };
  }

  /** One metric's reading, for the firm whose scope this runs in. */
  async read(metric: AdminAlertMetric, now: Date): Promise<number> {
    switch (metric) {
      case 'WITHDRAWALS_WAITING':
        return this.prisma.withdrawalRequest.count({
          where: { status: { in: ['REQUESTED', 'UNDER_REVIEW'] } },
        });
      case 'VERIFICATIONS_WAITING':
        return this.prisma.kycRecord.count({
          where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } },
        });
      case 'RECONCILIATION_OPEN':
        return this.prisma.reconciliationFinding.count({
          where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
        });
      case 'RISK_EVENTS_1H':
        return this.prisma.riskEvent.count({
          where: { createdAt: { gte: new Date(now.getTime() - HOUR) } },
        });
      case 'REJECTED_ORDERS_1H':
        return this.prisma.order.count({
          where: { status: 'REJECTED', updatedAt: { gte: new Date(now.getTime() - HOUR) } },
        });
      case 'CONNECTIONS_FAILING':
        return this.prisma.brokerConnection.count({
          where: {
            enabled: true,
            status: { in: ['DISCONNECTED', 'AUTH_FAILED', 'RATE_LIMITED'] },
          },
        });
      case 'REGISTRATIONS_24H':
        return this.prisma.user.count({
          where: { createdAt: { gte: new Date(now.getTime() - 24 * HOUR) } },
        });
    }
  }
}
