import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStateService } from '../trading/account-state.service';

/**
 * What a risk manager needs on one screen.
 *
 * The hard part is not the queries; it is deciding what "at risk" means without
 * either alarming somebody about nothing or valuing every account on the
 * platform to find out.
 *
 * The answer here is two passes. A cheap one over the database finds the
 * accounts that *could* be in trouble — those with margin committed at all —
 * and only those are valued live. An account with no open position cannot be
 * near a stop-out, and there is no reason to price one to discover that.
 */
@Injectable()
export class RiskConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
  ) {}

  /**
   * Accounts whose margin level is at or below `belowPercent`.
   *
   * Valued live rather than read from the last snapshot. A risk console showing
   * a margin level from the last snapshot is showing a number from before
   * whatever the manager is looking into — which is exactly the wrong minute to
   * be looking at.
   */
  async atRisk(options: { belowPercent?: number; limit?: number } = {}): Promise<AtRiskRow[]> {
    /**
     * No threshold means *every account with margin committed*, not a very
     * large number.
     *
     * The difference is not academic. A load-tested platform holds accounts at
     * five hundred thousand percent, so a filter that means "anything" by
     * passing 100,000 quietly hides them — and a risk console that answers
     * "nothing to see" when it was asked to show everything is worse than one
     * that has no such option.
     */
    const threshold = options.belowPercent ?? null;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const candidates = await this.prisma.position.findMany({
      where: { status: { in: ['OPEN', 'CLOSING'] } },
      select: { accountId: true },
      distinct: ['accountId'],
      // Bounded. A platform where thousands of accounts hold positions at once
      // is a platform where this page must still open.
      take: 2_000,
    });

    const rows: AtRiskRow[] = [];
    for (const candidate of candidates) {
      const valuation = await this.accountState.valuate(candidate.accountId);
      const level = valuation.state.marginLevel;
      // Null means no margin committed, which is not a margin level of zero.
      if (level === null) continue;
      if (threshold !== null && toDecimal(level.toString()).gt(threshold)) continue;

      const account = await this.prisma.account.findUnique({
        where: { id: candidate.accountId },
        select: {
          number: true,
          currency: true,
          user: { select: { id: true, email: true } },
          settings: {
            select: { marginCallLevelPercent: true, stopOutLevelPercent: true },
          },
        },
      });
      if (account === null) continue;

      rows.push({
        accountId: candidate.accountId,
        number: account.number,
        currency: account.currency,
        userId: account.user.id,
        email: account.user.email,
        equity: valuation.state.equity.toString(),
        balance: valuation.state.balance.toString(),
        usedMargin: valuation.state.usedMargin.toString(),
        freeMargin: valuation.state.freeMargin.toString(),
        marginLevel: level.toString(),
        floatingPnl: valuation.state.floatingPnl.toString(),
        openPositions: valuation.positions.length,
        marginCallLevelPercent: account.settings?.marginCallLevelPercent.toString() ?? null,
        stopOutLevelPercent: account.settings?.stopOutLevelPercent.toString() ?? null,
      });

      if (rows.length >= limit) break;
    }

    /**
     * Worst first. A list a risk manager has to sort themselves is a list whose
     * first row was chosen by the query planner.
     *
     * Compared as decimals, like the exposure sort below: this is the list
     * somebody reads top-down when deciding who to look at first, and the only
     * thing it promises is that the top of it is the top.
     */
    return rows.sort((a, b) => toDecimal(a.marginLevel).comparedTo(toDecimal(b.marginLevel)));
  }

  /**
   * Where the platform's exposure actually is, by instrument.
   *
   * Volume, not notional — deliberately. Notional would need every position
   * converted at a live rate, which turns a summary into a valuation of the
   * whole book; and the question this answers is "what are we all long of",
   * which volume answers directly. `GET /admin/risk/at-risk` is where the money
   * figures live.
   */
  async exposure(): Promise<ExposureRow[]> {
    const positions = await this.prisma.position.groupBy({
      by: ['symbolId', 'side'],
      where: { status: { in: ['OPEN', 'CLOSING'] } },
      _sum: { volume: true },
      _count: { _all: true },
    });

    const symbols = await this.prisma.symbol.findMany({ select: { id: true, code: true } });
    const codes = new Map(symbols.map((symbol) => [symbol.id, symbol.code]));

    const bySymbol = new Map<string, ExposureRow>();
    for (const row of positions) {
      const code = codes.get(row.symbolId) ?? row.symbolId;
      const existing = bySymbol.get(code) ?? {
        symbol: code,
        longVolume: '0',
        shortVolume: '0',
        netVolume: '0',
        positions: 0,
      };

      const volume = row._sum.volume?.toString() ?? '0';
      if (row.side === 'BUY') existing.longVolume = volume;
      else existing.shortVolume = volume;
      existing.positions += row._count._all;

      existing.netVolume = toDecimal(existing.longVolume)
        .minus(toDecimal(existing.shortVolume))
        .toString();
      bySymbol.set(code, existing);
    }

    /**
     * Ordered by size of net exposure, biggest first — as decimals.
     *
     * This sorted on `Math.abs(Number(...))`, three lines after computing
     * `netVolume` with `toDecimal().minus()` precisely so that it would not be
     * a float. Right instinct, wrong tool, one line apart, which is what this
     * class of defect looks like from the inside.
     *
     * The screen is a risk manager's list of where the firm is most exposed,
     * and the only thing it promises is that the top of it is the top. A
     * comparison that cannot separate two large exposures puts them in
     * whatever order the sort happened to visit them in.
     */
    return [...bySymbol.values()].sort((a, b) =>
      toDecimal(b.netVolume).abs().comparedTo(toDecimal(a.netVolume).abs()),
    );
  }

  /** Recorded risk decisions, newest first. */
  async events(query: {
    accountId?: string;
    severity?: string;
    rule?: string;
    sinceMs?: number;
    limit?: number;
  }): Promise<RiskEventRow[]> {
    const where: Prisma.RiskEventWhereInput = {};
    if (query.accountId !== undefined) where.accountId = query.accountId;
    if (query.severity !== undefined) where.severity = query.severity;
    if (query.rule !== undefined) where.rule = query.rule;
    if (query.sinceMs !== undefined) where.createdAt = { gte: new Date(query.sinceMs) };

    const events = await this.prisma.riskEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 100, 1), 500),
      select: {
        id: true,
        accountId: true,
        rule: true,
        code: true,
        severity: true,
        message: true,
        snapshot: true,
        createdAt: true,
        account: { select: { number: true } },
      },
    });

    return events.map((event) => ({
      id: event.id,
      accountId: event.accountId,
      accountNumber: event.account.number,
      rule: event.rule,
      code: event.code,
      severity: event.severity,
      message: event.message,
      snapshot: event.snapshot,
      createdAt: event.createdAt.toISOString(),
    }));
  }
}

export interface AtRiskRow {
  accountId: string;
  number: string;
  currency: string;
  userId: string;
  email: string;
  equity: string;
  balance: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string;
  floatingPnl: string;
  openPositions: number;
  marginCallLevelPercent: string | null;
  stopOutLevelPercent: string | null;
}

export interface ExposureRow {
  symbol: string;
  longVolume: string;
  shortVolume: string;
  netVolume: string;
  positions: number;
}

export interface RiskEventRow {
  id: string;
  accountId: string;
  accountNumber: string;
  rule: string;
  code: string;
  severity: string;
  message: unknown;
  snapshot: unknown;
  createdAt: string;
}
