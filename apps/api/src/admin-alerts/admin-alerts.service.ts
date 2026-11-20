import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { requireTenantId } from '@tp/tenancy';
import {
  DomainError,
  TradingErrorCode,
  isAdminAlertMetric,
  type AdminAlertComparator,
} from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface AlertRuleInput {
  readonly name: string;
  readonly metric: string;
  readonly comparator: AdminAlertComparator;
  readonly threshold: number;
  readonly cooldownMinutes: number;
  readonly enabled: boolean;
}

const RULE_SELECT = {
  id: true,
  name: true,
  metric: true,
  comparator: true,
  threshold: true,
  enabled: true,
  cooldownMinutes: true,
  lastValue: true,
  lastEvaluatedAt: true,
  inBreach: true,
  lastRaisedAt: true,
  updatedAt: true,
} as const;

/**
 * Admin alert rules and the alerts they raise. The worker reads the rules
 * (`AdminAlertsService` there); this is where people write them and work
 * through what they raised.
 */
@Injectable()
export class AdminAlertRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async rules() {
    const rows = await this.prisma.adminAlertRule.findMany({
      orderBy: { name: 'asc' },
      select: RULE_SELECT,
    });
    return rows.map((row) => ({
      ...row,
      lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
      lastRaisedAt: row.lastRaisedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async save(actorId: string, input: AlertRuleInput, id?: string) {
    const problems = ruleProblems(input);
    if (problems.length > 0) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, problems.join(' '), { problems });
    }
    const data = {
      name: input.name.trim(),
      metric: input.metric,
      comparator: input.comparator,
      threshold: input.threshold,
      cooldownMinutes: input.cooldownMinutes,
      enabled: input.enabled,
    };
    try {
      const before =
        id === undefined
          ? null
          : await this.prisma.adminAlertRule.findUnique({ where: { id }, select: RULE_SELECT });
      if (id !== undefined && before === null) {
        throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such alert rule.');
      }
      const row =
        id === undefined
          ? await this.prisma.adminAlertRule.create({
              data: { ...data, tenantId: requireTenantId(), createdById: actorId },
              select: { id: true },
            })
          : await this.prisma.adminAlertRule.update({
              where: { id },
              // A changed condition starts fresh: the next reading decides
              // whether it is breached, and a breach then raises at once.
              data: { ...data, inBreach: false },
              select: { id: true },
            });
      await this.audit.record({
        actorType: 'ADMIN',
        actorId,
        action: id === undefined ? 'ALERT_RULE_CREATED' : 'ALERT_RULE_UPDATED',
        resourceType: 'AdminAlertRule',
        resourceId: row.id,
        ...(before === null ? {} : { before: { ...data, ...pick(before) } }),
        after: { ...data },
      });
      return (await this.rules()).find((rule) => rule.id === row.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `There is already a rule called ${input.name.trim()}.`,
        );
      }
      throw error;
    }
  }

  async remove(actorId: string, id: string): Promise<void> {
    const rule = await this.prisma.adminAlertRule.findUnique({
      where: { id },
      select: RULE_SELECT,
    });
    if (rule === null)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such alert rule.');
    await this.prisma.adminAlertRule.delete({ where: { id } });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'ALERT_RULE_DELETED',
      resourceType: 'AdminAlertRule',
      resourceId: id,
      before: pick(rule),
    });
  }

  /** Unacknowledged first, newest first; at most `limit`. */
  async alerts(state: 'open' | 'all', limit: number) {
    const rows = await this.prisma.adminAlert.findMany({
      where: state === 'open' ? { acknowledgedAt: null } : {},
      orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    const open = await this.prisma.adminAlert.count({ where: { acknowledgedAt: null } });
    return {
      open,
      alerts: rows.map((row) => ({
        id: row.id,
        ruleId: row.ruleId,
        ruleName: row.ruleName,
        metric: row.metric,
        comparator: row.comparator,
        threshold: row.threshold,
        value: row.value,
        raisedAt: row.raisedAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        note: row.note,
      })),
    };
  }

  async acknowledge(actorId: string, id: string, note: string | null): Promise<void> {
    const updated = await this.prisma.adminAlert.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedById: actorId, note },
    });
    if (updated.count === 0) {
      const exists = await this.prisma.adminAlert.count({ where: { id } });
      throw new DomainError(
        exists === 0 ? TradingErrorCode.RESOURCE_NOT_FOUND : TradingErrorCode.VALIDATION_FAILED,
        exists === 0 ? 'No such alert.' : 'This alert was already acknowledged.',
      );
    }
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'ALERT_ACKNOWLEDGED',
      resourceType: 'AdminAlert',
      resourceId: id,
      after: { note },
    });
  }
}

function pick(rule: {
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  cooldownMinutes: number;
  enabled: boolean;
}) {
  return {
    name: rule.name,
    metric: rule.metric,
    comparator: rule.comparator,
    threshold: rule.threshold,
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
  };
}

export function ruleProblems(input: AlertRuleInput): string[] {
  const problems: string[] = [];
  if (input.name.trim() === '') problems.push('Give the rule a name.');
  if (input.name.trim().length > 80) problems.push('The name can be at most 80 characters.');
  if (!isAdminAlertMetric(input.metric))
    problems.push(`Nothing called ${input.metric} can be watched.`);
  if (!Number.isInteger(input.threshold) || input.threshold < 0 || input.threshold > 1_000_000) {
    problems.push('The threshold must be a whole number from 0 to 1,000,000.');
  }
  if (input.comparator === 'BELOW' && input.threshold === 0) {
    problems.push('A count is never below zero: that rule could never fire.');
  }
  if (
    !Number.isInteger(input.cooldownMinutes) ||
    input.cooldownMinutes < 1 ||
    input.cooldownMinutes > 10_080
  ) {
    problems.push('The quiet period must be 1 minute to 7 days.');
  }
  return problems;
}
