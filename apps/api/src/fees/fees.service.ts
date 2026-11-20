import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { requireTenantId } from '@tp/tenancy';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import type { SymbolSpec } from '@tp/financial-core';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** A rate as typed: a non-negative decimal, at most 10 places. */
const RATE = /^\d{1,18}(\.\d{1,10})?$/;

export interface FeeScheduleView {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly defaultCommissionPerLot: string | null;
  readonly rules: ReadonlyArray<{ readonly symbol: string; readonly commissionPerLot: string }>;
  readonly accounts: number;
  readonly updatedAt: string;
}

export interface FeeScheduleInput {
  readonly name: string;
  readonly note?: string | null;
  readonly defaultCommissionPerLot?: string | null;
  readonly rules: ReadonlyArray<{ readonly symbol: string; readonly commissionPerLot: string }>;
}

export interface FeeTotals {
  readonly currency: string;
  /** Commission charged: positive, as a cost to traders and income to the firm. */
  readonly commission: string;
  /** Swap settled: signed as traders saw it — negative charged them. */
  readonly swap: string;
}

export interface FeeReport {
  readonly from: string;
  readonly to: string;
  readonly totals: readonly FeeTotals[];
  readonly bySymbol: ReadonlyArray<FeeTotals & { readonly symbol: string }>;
  readonly topAccounts: ReadonlyArray<{
    readonly accountId: string;
    readonly number: string;
    readonly schedule: string | null;
    readonly currency: string;
    readonly commission: string;
  }>;
  /** True when more positions paid fees than the report groups; totals are still whole. */
  readonly truncated: boolean;
}

const MAX_REPORT_DAYS = 366;
const MAX_POSITIONS_GROUPED = 50_000;

/**
 * Commission schedules, and what fees came to.
 *
 * The one method the trading engine calls is `commissionSpec`: given the
 * instrument's terms as the firm sets them and the account, it returns the
 * terms with the commission the account actually pays. An account on no
 * schedule pays the standard terms and costs one indexed read. It is read
 * fresh on every order rather than cached, because a cached rate is a rate
 * that keeps charging for a while after somebody changed it, and every other
 * API process would keep its own stale copy.
 */
@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async commissionSpec(
    spec: SymbolSpec,
    symbolCode: string,
    accountId: string,
  ): Promise<SymbolSpec> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        feeSchedule: {
          select: {
            defaultCommissionPerLot: true,
            rules: {
              where: { symbol: { code: symbolCode } },
              select: { commissionPerLot: true },
            },
          },
        },
      },
    });
    const schedule = account?.feeSchedule;
    if (schedule === null || schedule === undefined) return spec;
    const rate = schedule.rules[0]?.commissionPerLot ?? schedule.defaultCommissionPerLot;
    return rate === null ? spec : { ...spec, commissionPerLot: rate.toString() };
  }

  async list(): Promise<FeeScheduleView[]> {
    const rows = await this.prisma.feeSchedule.findMany({
      orderBy: { name: 'asc' },
      include: {
        rules: { include: { symbol: { select: { code: true } } } },
        _count: { select: { accounts: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      note: row.note,
      defaultCommissionPerLot: row.defaultCommissionPerLot?.toString() ?? null,
      rules: row.rules
        .map((rule) => ({
          symbol: rule.symbol.code,
          commissionPerLot: rule.commissionPerLot.toString(),
        }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      accounts: row._count.accounts,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Creates the schedule, or replaces one wholesale: its rules are exactly those given. */
  async save(actorId: string, input: FeeScheduleInput, id?: string): Promise<FeeScheduleView> {
    const name = input.name.trim();
    const problems = scheduleProblems(input);
    if (problems.length > 0) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, problems.join(' '), { problems });
    }
    const tenantId = requireTenantId();
    const codes = [...new Set(input.rules.map((rule) => rule.symbol))];
    const symbols = await this.prisma.symbol.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const unknown = codes.filter((code) => !symbols.some((symbol) => symbol.code === code));
    if (unknown.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `No such instrument: ${unknown.join(', ')}.`,
        { unknown },
      );
    }
    const idOf = new Map(symbols.map((symbol) => [symbol.code, symbol.id]));
    const before = id === undefined ? null : (await this.list()).find((row) => row.id === id);
    if (id !== undefined && before === undefined) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such fee schedule.');
    }

    try {
      const savedId = await this.prisma.$transaction(async (tx) => {
        const data = {
          name,
          note: input.note?.trim() === '' ? null : (input.note?.trim() ?? null),
          defaultCommissionPerLot:
            input.defaultCommissionPerLot === null || input.defaultCommissionPerLot === undefined
              ? null
              : new Prisma.Decimal(input.defaultCommissionPerLot),
        };
        const schedule =
          id === undefined
            ? await tx.feeSchedule.create({ data: { tenantId, ...data } })
            : await tx.feeSchedule.update({ where: { id }, data });
        await tx.feeRule.deleteMany({ where: { scheduleId: schedule.id } });
        if (input.rules.length > 0) {
          await tx.feeRule.createMany({
            data: input.rules.map((rule) => ({
              tenantId,
              scheduleId: schedule.id,
              symbolId: idOf.get(rule.symbol) as string,
              commissionPerLot: new Prisma.Decimal(rule.commissionPerLot),
            })),
          });
        }
        return schedule.id;
      });
      const after = (await this.list()).find((row) => row.id === savedId) as FeeScheduleView;
      await this.audit.record({
        actorType: 'ADMIN',
        actorId,
        action: id === undefined ? 'FEE_SCHEDULE_CREATED' : 'FEE_SCHEDULE_UPDATED',
        resourceType: 'FeeSchedule',
        resourceId: savedId,
        ...(before === null || before === undefined ? {} : { before: { ...before } }),
        after: { ...after },
      });
      this.logger.log(
        { scheduleId: savedId, rules: input.rules.length },
        `Fee schedule ${name} saved`,
      );
      return after;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `There is already a schedule called ${name}.`,
        );
      }
      throw error;
    }
  }

  /** Only an unused schedule: removing one under live accounts would change what they pay. */
  async remove(actorId: string, id: string): Promise<void> {
    const row = (await this.list()).find((schedule) => schedule.id === id);
    if (row === undefined)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such fee schedule.');
    if (row.accounts > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${row.accounts} account(s) pay this schedule. Move them to another one first.`,
        { accounts: row.accounts },
      );
    }
    await this.prisma.feeSchedule.delete({ where: { id } });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'FEE_SCHEDULE_DELETED',
      resourceType: 'FeeSchedule',
      resourceId: id,
      before: { ...row },
    });
  }

  /** Puts an account on a schedule, or back on the standard terms with `null`. */
  async assign(
    actorId: string,
    accountId: string,
    scheduleId: string | null,
    reason: string,
  ): Promise<{ accountId: string; schedule: string | null }> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, number: true, feeSchedule: { select: { id: true, name: true } } },
    });
    if (account === null)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such account.');
    const schedule =
      scheduleId === null
        ? null
        : await this.prisma.feeSchedule.findUnique({
            where: { id: scheduleId },
            select: { id: true, name: true },
          });
    if (scheduleId !== null && schedule === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such fee schedule.');
    }
    await this.prisma.account.update({
      where: { id: accountId },
      data: { feeScheduleId: schedule?.id ?? null },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'ACCOUNT_FEE_SCHEDULE_CHANGED',
      resourceType: 'Account',
      resourceId: accountId,
      before: { schedule: account.feeSchedule?.name ?? null },
      after: { schedule: schedule?.name ?? null, reason: reason.trim() },
    });
    return { accountId, schedule: schedule?.name ?? null };
  }

  /**
   * What fees came to over a period, from the ledger — commission charged and
   * swap settled, by currency (never summed across currencies), by instrument
   * and for the accounts that paid most commission.
   */
  async report(from: Date, to: Date): Promise<FeeReport> {
    if (!(from < to)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'The period must end after it starts.',
      );
    }
    if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * 86_400_000) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A fee report covers at most ${MAX_REPORT_DAYS} days.`,
      );
    }
    const where = {
      type: { in: ['COMMISSION', 'SWAP'] as Array<'COMMISSION' | 'SWAP'> },
      createdAt: { gte: from, lt: to },
    };

    const totals = await this.prisma.balanceLedger.groupBy({
      by: ['currency', 'type'],
      where,
      _sum: { amount: true },
    });

    const perPosition = await this.prisma.balanceLedger.groupBy({
      by: ['referenceId', 'currency', 'type'],
      where: { ...where, referenceType: 'Position' },
      _sum: { amount: true },
      take: MAX_POSITIONS_GROUPED + 1,
      orderBy: { referenceId: 'asc' },
    });
    const truncated = perPosition.length > MAX_POSITIONS_GROUPED;
    const grouped = perPosition.slice(0, MAX_POSITIONS_GROUPED);
    const positionIds = [
      ...new Set(grouped.map((row) => row.referenceId).filter((id): id is string => id !== null)),
    ];
    const symbolOf = new Map<string, string>();
    for (let i = 0; i < positionIds.length; i += 5_000) {
      const positions = await this.prisma.position.findMany({
        where: { id: { in: positionIds.slice(i, i + 5_000) } },
        select: { id: true, symbol: { select: { code: true } } },
      });
      for (const position of positions) symbolOf.set(position.id, position.symbol.code);
    }

    const accounts = await this.prisma.balanceLedger.groupBy({
      by: ['accountId', 'currency'],
      where: { ...where, type: 'COMMISSION' },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'asc' } },
      take: 20,
    });
    const accountRows = await this.prisma.account.findMany({
      where: { id: { in: accounts.map((row) => row.accountId) } },
      select: { id: true, number: true, feeSchedule: { select: { name: true } } },
    });
    const accountOf = new Map(accountRows.map((row) => [row.id, row]));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: fold(totals.map((row) => ({ key: '', ...row }))).map(
        ({ key: _key, ...rest }) => rest,
      ),
      bySymbol: fold(
        grouped.map((row) => ({
          key: row.referenceId === null ? '—' : (symbolOf.get(row.referenceId) ?? '—'),
          currency: row.currency,
          type: row.type,
          _sum: row._sum,
        })),
      )
        .map(({ key, ...rest }) => ({ symbol: key, ...rest }))
        .sort((a, b) => new Prisma.Decimal(b.commission).cmp(new Prisma.Decimal(a.commission))),
      topAccounts: accounts.map((row) => ({
        accountId: row.accountId,
        number: accountOf.get(row.accountId)?.number ?? '—',
        schedule: accountOf.get(row.accountId)?.feeSchedule?.name ?? null,
        currency: row.currency,
        commission: (row._sum.amount ?? new Prisma.Decimal(0)).negated().toFixed(2),
      })),
      truncated,
    };
  }
}

/** Folds ledger sums (commission negative as a debit) into fee lines, per key and currency. */
function fold(
  rows: ReadonlyArray<{
    key: string;
    currency: string;
    type: string;
    _sum: { amount: Prisma.Decimal | null };
  }>,
): Array<FeeTotals & { key: string }> {
  const lines = new Map<
    string,
    { key: string; currency: string; commission: Prisma.Decimal; swap: Prisma.Decimal }
  >();
  for (const row of rows) {
    const id = `${row.key}\u0000${row.currency}`;
    const line = lines.get(id) ?? {
      key: row.key,
      currency: row.currency,
      commission: new Prisma.Decimal(0),
      swap: new Prisma.Decimal(0),
    };
    const amount = row._sum.amount ?? new Prisma.Decimal(0);
    if (row.type === 'COMMISSION') line.commission = line.commission.minus(amount);
    else line.swap = line.swap.plus(amount);
    lines.set(id, line);
  }
  return [...lines.values()]
    .sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency))
    .map((line) => ({
      key: line.key,
      currency: line.currency,
      commission: line.commission.toFixed(2),
      swap: line.swap.toFixed(2),
    }));
}

/** Every reason a schedule cannot be saved, in words for the person writing it. */
export function scheduleProblems(input: FeeScheduleInput): string[] {
  const problems: string[] = [];
  const name = input.name.trim();
  if (name === '') problems.push('Give the schedule a name.');
  if (name.length > 60) problems.push('The name can be at most 60 characters.');
  if (
    input.defaultCommissionPerLot !== null &&
    input.defaultCommissionPerLot !== undefined &&
    !RATE.test(input.defaultCommissionPerLot)
  ) {
    problems.push('The default rate must be a number of zero or more, with at most 10 decimals.');
  }
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!RATE.test(rule.commissionPerLot)) {
      problems.push(
        `${rule.symbol}: the rate must be a number of zero or more, with at most 10 decimals.`,
      );
    }
    if (seen.has(rule.symbol)) problems.push(`${rule.symbol} is listed twice.`);
    seen.add(rule.symbol);
  }
  if (input.rules.length > 500) problems.push('A schedule can list at most 500 instruments.');
  return problems;
}
