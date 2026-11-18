import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Challenge, type ChallengePhase, type ChallengePlan } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import {
  dayIn,
  dayNumber,
  evaluateChallenge,
  termsProblem,
  type ChallengeMetrics,
  type ChallengeTerms,
  type ChallengeVerdict,
} from '@tp/trading-core';
import type { Env } from '../config/env.schema';
import { AuditService } from '../common/audit/audit.service';
import { AccountsService } from '../accounts/accounts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStateService } from '../trading/account-state.service';
import { QuoteService } from '../market/quote.service';

/** A trader may hold this many unpaid challenges at once. */
export const MAX_UNPAID = 3;

export interface PlanInput {
  readonly name: string;
  readonly steps: 1 | 2;
  readonly accountSize: string;
  readonly accountCurrency: string;
  readonly leverage: number;
  readonly price: string;
  readonly paymentAsset: string;
  readonly paymentNetwork: string;
  readonly paymentAddress: string | null;
  readonly phaseOneTargetPct: string;
  readonly phaseTwoTargetPct: string | null;
  readonly dailyLossPct: string;
  readonly maxLossPct: string;
  readonly drawdownMode: 'STATIC' | 'TRAILING';
  readonly trailingLock: boolean;
  readonly dailyBasis: 'BALANCE' | 'EQUITY' | 'HIGHER';
  readonly minTradingDays: number;
  readonly maxDays: number | null;
  readonly profitSplitPct: string;
  readonly isActive: boolean;
}

export type EvaluationOutcome =
  | { readonly kind: 'DEFERRED'; readonly reason: string }
  | { readonly kind: 'ONGOING' }
  | { readonly kind: 'FAILED'; readonly rule: string }
  | { readonly kind: 'ADVANCED'; readonly to: ChallengePhase };

const RUNNING = ['ACTIVE', 'FUNDED'] as const;

/**
 * Prop-firm evaluations: plans, purchases, the fee, and the rules.
 *
 * The fee is paid outside the platform — a crypto transfer to the plan's
 * address — and confirmed by a person who has seen it arrive: nothing here
 * takes a transaction hash the trader typed as proof of payment. A confirmed
 * fee opens a demo account of the size bought, and from then on the
 * evaluator decides the challenge from that account's own figures.
 *
 * The evaluator never fails a challenge on something it could not see. An
 * account with a position that has no fresh price is skipped for the pass,
 * and a valuation that throws is a deferral, not a breach — a feed outage is
 * not a trader breaking a rule.
 */
@Injectable()
export class ChallengesService {
  private readonly logger = new Logger(ChallengesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly states: AccountStateService,
    private readonly quotes: QuoteService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------------------------------------------------------------- plans

  /** What a trader can buy: active plans that have somewhere to pay. */
  async offered() {
    const rows = await this.prisma.challengePlan.findMany({
      where: { isActive: true, paymentAddress: { not: null } },
      orderBy: [{ accountSize: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => planView(row, false));
  }

  async allPlans() {
    const rows = await this.prisma.challengePlan.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => planView(row, true));
  }

  async createPlan(actorId: string, input: PlanInput) {
    checkPlan(input);
    const row = await this.prisma.challengePlan.create({
      data: { tenantId: requireTenantId(), ...planData(input) },
    });
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'challenge.plan_created',
      resourceType: 'ChallengePlan',
      resourceId: row.id,
      after: planView(row, true) as unknown as Prisma.InputJsonValue,
    });
    return planView(row, true);
  }

  async updatePlan(actorId: string, id: string, input: PlanInput) {
    checkPlan(input);
    const before = await this.prisma.challengePlan.findUnique({ where: { id } });
    if (before === null) throw notFound('Challenge plan not found');
    const row = await this.prisma.challengePlan.update({ where: { id }, data: planData(input) });
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'challenge.plan_updated',
      resourceType: 'ChallengePlan',
      resourceId: id,
      before: planView(before, true) as unknown as Prisma.InputJsonValue,
      after: planView(row, true) as unknown as Prisma.InputJsonValue,
    });
    return planView(row, true);
  }

  // ----------------------------------------------------------- the trader

  async mine(userId: string) {
    const rows = await this.prisma.challenge.findMany({
      where: { userId },
      include: { account: { select: { number: true } }, certificates: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => challengeView(row));
  }

  async one(userId: string | null, id: string) {
    const row = await this.prisma.challenge.findFirst({
      where: { id, ...(userId === null ? {} : { userId }) },
      include: {
        account: { select: { number: true } },
        certificates: true,
        events: { orderBy: { createdAt: 'asc' } },
        ...(userId === null ? { user: { select: { email: true, displayName: true } } } : {}),
      },
    });
    if (row === null) throw notFound('Challenge not found');
    return {
      ...challengeView(row),
      ...('user' in row && row.user !== undefined ? { trader: row.user } : {}),
      events: row.events.map((event) => ({
        kind: event.kind,
        phase: event.phase,
        details: event.details,
        at: event.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Buying is reserving terms and an address, nothing more. A second purchase
   * of the same plan while the first is unpaid returns the first: a double
   * click is one challenge.
   */
  async purchase(userId: string, planId: string) {
    const plan = await this.prisma.challengePlan.findFirst({
      where: { id: planId, isActive: true, paymentAddress: { not: null } },
    });
    if (plan === null || plan.paymentAddress === null) {
      throw notFound('That challenge is not on sale');
    }
    const unpaid = await this.prisma.challenge.findMany({
      where: { userId, status: 'AWAITING_PAYMENT' },
      include: { account: { select: { number: true } }, certificates: true },
    });
    const same = unpaid.find((row) => row.planId === planId);
    if (same !== undefined) return challengeView(same);
    if (unpaid.length >= MAX_UNPAID) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `You already have ${MAX_UNPAID} unpaid challenges. Pay or cancel one first.`,
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.challenge.create({
        data: {
          tenantId: requireTenantId(),
          userId,
          planId,
          planName: plan.name,
          steps: plan.steps,
          accountSize: plan.accountSize,
          accountCurrency: plan.accountCurrency,
          leverage: plan.leverage,
          price: plan.price,
          paymentAsset: plan.paymentAsset,
          paymentNetwork: plan.paymentNetwork,
          paymentAddress: plan.paymentAddress ?? '',
          phaseOneTargetPct: plan.phaseOneTargetPct,
          phaseTwoTargetPct: plan.phaseTwoTargetPct,
          dailyLossPct: plan.dailyLossPct,
          maxLossPct: plan.maxLossPct,
          drawdownMode: plan.drawdownMode,
          trailingLock: plan.trailingLock,
          dailyBasis: plan.dailyBasis,
          minTradingDays: plan.minTradingDays,
          maxDays: plan.maxDays,
          profitSplitPct: plan.profitSplitPct,
        },
        include: { account: { select: { number: true } }, certificates: true },
      });
      await event(tx, created, 'PURCHASED', userId, { planId, price: plan.price.toString() });
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'USER',
          action: 'challenge.purchased',
          resourceType: 'Challenge',
          resourceId: created.id,
          after: { planId, price: plan.price.toString(), asset: plan.paymentAsset },
        },
        tx,
      );
      return created;
    });
    return challengeView(row);
  }

  async submitPayment(userId: string, id: string, transactionHash: string) {
    const row = await this.prisma.challenge.findFirst({ where: { id, userId } });
    if (row === null) throw notFound('Challenge not found');
    if (row.status !== 'AWAITING_PAYMENT') {
      throw conflict('This challenge is not waiting for a payment');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const moved = await tx.challenge.updateMany({
          where: { id, userId, status: 'AWAITING_PAYMENT', version: row.version },
          data: { status: 'PAYMENT_REVIEW', transactionHash, version: { increment: 1 } },
        });
        if (moved.count === 0) throw conflict('This challenge changed; reload and try again');
        await event(tx, row, 'PAYMENT_SUBMITTED', userId, { transactionHash });
        await this.audit.record(
          {
            actorId: userId,
            actorType: 'USER',
            action: 'challenge.payment_submitted',
            resourceType: 'Challenge',
            resourceId: id,
            after: { transactionHash },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          'That transaction has already been submitted for a challenge.',
        );
      }
      throw error;
    }
    return this.one(userId, id);
  }

  async cancel(userId: string, id: string) {
    const row = await this.prisma.challenge.findFirst({ where: { id, userId } });
    if (row === null) throw notFound('Challenge not found');
    if (row.status !== 'AWAITING_PAYMENT') {
      throw conflict('Only a challenge that has not been paid for can be cancelled');
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.challenge.updateMany({
        where: { id, status: 'AWAITING_PAYMENT', version: row.version },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });
      if (moved.count === 0) throw conflict('This challenge changed; reload and try again');
      await event(tx, row, 'CANCELLED', userId, {});
    });
    return this.one(userId, id);
  }

  /** A certificate, for anyone holding its code. */
  async certificate(code: string) {
    const row = await this.prisma.challengeCertificate.findUnique({ where: { code } });
    if (row === null) throw notFound('No certificate has that code');
    return {
      code: row.code,
      phase: row.phase,
      traderName: row.traderName,
      accountSize: row.accountSize.toString(),
      currency: row.currency,
      issuedAt: row.issuedAt.toISOString(),
    };
  }

  // ------------------------------------------------------------ the desk

  async list(status: Challenge['status'] | undefined) {
    const rows = await this.prisma.challenge.findMany({
      where: status === undefined ? {} : { status },
      include: {
        account: { select: { number: true } },
        certificates: true,
        user: { select: { email: true, displayName: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({ ...challengeView(row), trader: row.user }));
  }

  /**
   * The fee has arrived, or it has not. Confirming opens the phase-one account
   * in the same transaction that moves the challenge to ACTIVE, so there is no
   * paid challenge without an account and no account without a challenge.
   */
  async decidePayment(actorId: string, id: string, confirmed: boolean, reason: string | null) {
    const row = await this.prisma.challenge.findUnique({ where: { id } });
    if (row === null) throw notFound('Challenge not found');
    if (row.status !== 'PAYMENT_REVIEW') throw conflict('This challenge is not waiting for review');
    if (!confirmed && (reason === null || reason.trim() === '')) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'Say why the payment was refused');
    }

    const now = new Date();
    const accountNumber = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.challenge.updateMany({
        where: { id, status: 'PAYMENT_REVIEW', version: row.version },
        data: { version: { increment: 1 } },
      });
      if (claimed.count === 0) throw conflict('Somebody else decided this payment first');

      if (!confirmed) {
        await tx.challenge.update({ where: { id }, data: { status: 'CANCELLED' } });
        await event(tx, row, 'PAYMENT_REJECTED', actorId, { reason });
        await this.audit.record(
          {
            actorId,
            actorType: 'ADMIN',
            action: 'challenge.payment_rejected',
            resourceType: 'Challenge',
            resourceId: id,
            after: { reason, transactionHash: row.transactionHash },
          },
          tx,
        );
        return null;
      }

      const account = await this.openPhaseAccount(tx, row, 'PHASE_ONE');
      await tx.challenge.update({
        where: { id },
        data: { status: 'ACTIVE', ...this.phaseStart(row, 'PHASE_ONE', account.id, now) },
      });
      await event(tx, row, 'PAYMENT_CONFIRMED', actorId, { accountNumber: account.number });
      await event(
        tx,
        row,
        'PHASE_STARTED',
        actorId,
        { accountNumber: account.number },
        'PHASE_ONE',
        account.id,
      );
      await this.audit.record(
        {
          actorId,
          actorType: 'ADMIN',
          action: 'challenge.payment_confirmed',
          resourceType: 'Challenge',
          resourceId: id,
          after: { transactionHash: row.transactionHash, accountId: account.id },
        },
        tx,
      );
      return account.number;
    });

    await this.notifications.raise({
      userId: row.userId,
      kind: confirmed ? 'challenge.started' : 'challenge.payment_rejected',
      severity: confirmed ? 'INFO' : 'WARNING',
      title: confirmed ? 'Your challenge has started' : 'Your challenge payment was not accepted',
      body: confirmed
        ? `${row.planName}: phase 1 is open on account #${accountNumber ?? ''}.`
        : `${row.planName}: ${reason ?? ''}`,
      data: { challengeId: id },
      dedupeKey: `challenge:${id}:payment`,
    });
    return this.one(null, id);
  }

  // ------------------------------------------------------- the evaluator

  /** Every running challenge in the current tenant, once. */
  async evaluateAll(now = new Date()): Promise<Record<EvaluationOutcome['kind'], number>> {
    const running = await this.prisma.challenge.findMany({
      where: { status: { in: [...RUNNING] }, accountId: { not: null } },
      select: { id: true },
    });
    const counts = { DEFERRED: 0, ONGOING: 0, FAILED: 0, ADVANCED: 0 };
    for (const { id } of running) {
      try {
        const outcome = await this.evaluate(id, now);
        counts[outcome.kind] += 1;
      } catch (error) {
        counts.DEFERRED += 1;
        this.logger.error({ err: error, challengeId: id }, 'Challenge evaluation failed');
      }
    }
    return counts;
  }

  async evaluate(id: string, now = new Date()): Promise<EvaluationOutcome> {
    const row = await this.prisma.challenge.findUnique({ where: { id } });
    if (row === null || row.accountId === null || !RUNNING.includes(row.status as 'ACTIVE')) {
      return { kind: 'DEFERRED', reason: 'not running' };
    }
    const accountId = row.accountId;

    let valuation;
    try {
      valuation = await this.states.valuate(accountId);
    } catch (error) {
      this.logger.warn({ err: error, challengeId: id }, 'Challenge account could not be valued');
      return { kind: 'DEFERRED', reason: 'valuation failed' };
    }
    if (valuation.positions.some((position) => position.stale)) {
      return { kind: 'DEFERRED', reason: 'a position has no price' };
    }
    // A price the engine would refuse to trade on is not one to fail anybody on.
    for (const symbol of new Set(valuation.positions.map((position) => position.symbol))) {
      try {
        await this.quotes.requireFresh(symbol);
      } catch {
        return { kind: 'DEFERRED', reason: `the ${symbol} price is not fresh` };
      }
    }

    const timeZone = this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true });
    const today = dayIn(now, timeZone);
    const balance = valuation.state.balance.toString();
    const equity = valuation.state.equity.toString();
    const newDay = row.dayKey !== today || row.dayStartBalance === null;
    const dayStartBalance = newDay ? balance : (row.dayStartBalance?.toString() ?? balance);
    const dayStartEquity = newDay ? equity : (row.dayStartEquity?.toString() ?? equity);

    const opened = await this.prisma.position.findMany({
      where: { accountId },
      select: { openedAt: true },
    });
    const tradingDays = new Set(opened.map((p) => dayIn(p.openedAt, timeZone))).size;

    const verdict = evaluateChallenge(termsOf(row), {
      initialBalance: row.accountSize.toString(),
      dayStartBalance,
      dayStartEquity,
      highWaterEquity: row.highWaterEquity?.toString() ?? row.accountSize.toString(),
      balance,
      equity,
      openPositions: valuation.openPositionCount,
      tradingDays,
      dayNumber: dayNumber(row.phaseStartDay ?? today, today),
    });
    const observed = { balance, equity, openPositions: valuation.openPositionCount };

    if (verdict.kind === 'ONGOING' || (verdict.kind === 'PASSED' && row.phase === 'FUNDED')) {
      await this.prisma.challenge.updateMany({
        where: { id, version: row.version },
        data: {
          dayKey: today,
          dayStartBalance,
          dayStartEquity,
          highWaterEquity: verdict.metrics.highWaterEquity,
          lastMetrics: metricsJson(verdict.metrics, observed),
          lastEvaluatedAt: now,
        },
      });
      return { kind: 'ONGOING' };
    }

    if (verdict.kind === 'BREACHED') return this.fail(row, verdict, observed, now);
    return this.advance(row, verdict.metrics, observed, now);
  }

  private async fail(
    row: Challenge,
    verdict: Extract<ChallengeVerdict, { kind: 'BREACHED' }>,
    observed: Record<string, unknown>,
    now: Date,
  ): Promise<EvaluationOutcome> {
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.challenge.updateMany({
        where: { id: row.id, version: row.version, status: { in: [...RUNNING] } },
        data: {
          status: 'FAILED',
          failedRule: verdict.rule,
          failedAt: now,
          lastMetrics: metricsJson(verdict.metrics, observed),
          lastEvaluatedAt: now,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) return false;
      if (row.accountId !== null) {
        // Close-only: the trader can still take risk off, never add it.
        await tx.account.update({ where: { id: row.accountId }, data: { status: 'CLOSE_ONLY' } });
      }
      await event(tx, row, 'RULE_BREACHED', null, {
        rule: verdict.rule,
        at: now.toISOString(),
        ...observed,
        metrics: verdict.metrics,
      });
      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'challenge.failed',
          resourceType: 'Challenge',
          resourceId: row.id,
          after: { rule: verdict.rule, ...observed } as Prisma.InputJsonValue,
        },
        tx,
      );
      return true;
    });
    if (!done) return { kind: 'DEFERRED', reason: 'changed underneath' };

    await this.notifications.raise({
      userId: row.userId,
      kind: 'challenge.failed',
      severity: 'CRITICAL',
      title: 'Your challenge has ended',
      body: `${row.planName}: ${RULE_WORDS[verdict.rule]} Equity ${String(observed['equity'])}. The account is now close-only.`,
      data: { challengeId: row.id, rule: verdict.rule },
      accountId: row.accountId,
      dedupeKey: `challenge:${row.id}:failed`,
    });
    return { kind: 'FAILED', rule: verdict.rule };
  }

  private async advance(
    row: Challenge,
    metrics: ChallengeMetrics,
    observed: Record<string, unknown>,
    now: Date,
  ): Promise<EvaluationOutcome> {
    const next: ChallengePhase =
      row.phase === 'PHASE_ONE' && row.steps === 2 ? 'PHASE_TWO' : 'FUNDED';
    const trader = await this.prisma.user.findUniqueOrThrow({
      where: { id: row.userId },
      select: { displayName: true },
    });
    const code = certificateCode();

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.challenge.updateMany({
        where: { id: row.id, version: row.version, status: 'ACTIVE', phase: row.phase },
        data: { version: { increment: 1 } },
      });
      if (claimed.count === 0) return null;
      if (row.accountId !== null) {
        await tx.account.update({ where: { id: row.accountId }, data: { status: 'CLOSE_ONLY' } });
      }
      await tx.challengeCertificate.create({
        data: {
          tenantId: requireTenantId(),
          challengeId: row.id,
          code,
          phase: row.phase,
          traderName: trader.displayName,
          accountSize: row.accountSize,
          currency: row.accountCurrency,
        },
      });
      await event(tx, row, 'PHASE_PASSED', null, {
        certificate: code,
        ...observed,
        metrics,
      });
      const account = await this.openPhaseAccount(tx, row, next);
      await tx.challenge.update({
        where: { id: row.id },
        data: {
          status: next === 'FUNDED' ? 'FUNDED' : 'ACTIVE',
          ...(next === 'FUNDED' ? { fundedAt: now } : {}),
          ...this.phaseStart(row, next, account.id, now),
        },
      });
      await event(
        tx,
        row,
        next === 'FUNDED' ? 'FUNDED' : 'PHASE_STARTED',
        null,
        { accountNumber: account.number },
        next,
        account.id,
      );
      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'challenge.phase_passed',
          resourceType: 'Challenge',
          resourceId: row.id,
          after: { passed: row.phase, next, certificate: code, accountId: account.id },
        },
        tx,
      );
      return account.number;
    });
    if (result === null) return { kind: 'DEFERRED', reason: 'changed underneath' };

    await this.notifications.raise({
      userId: row.userId,
      kind: 'challenge.passed',
      severity: 'INFO',
      title: next === 'FUNDED' ? 'You are funded' : 'Phase 1 passed',
      body: `${row.planName}: certificate ${code}. ${next === 'FUNDED' ? 'Your funded' : 'Your phase 2'} account is #${result}.`,
      data: { challengeId: row.id, certificate: code },
      dedupeKey: `challenge:${row.id}:passed:${row.phase}`,
    });
    return { kind: 'ADVANCED', to: next };
  }

  private async openPhaseAccount(
    tx: Prisma.TransactionClient,
    row: Challenge,
    phase: ChallengePhase,
  ) {
    return this.accounts.openAccount(tx, row.userId, {
      type: 'DEMO',
      currency: row.accountCurrency,
      leverage: row.leverage,
      initialBalance: row.accountSize.toString(),
      openingDescription: `Challenge ${phase === 'FUNDED' ? 'funded' : phase === 'PHASE_TWO' ? 'phase 2' : 'phase 1'} opening balance`,
    });
  }

  private phaseStart(row: Challenge, phase: ChallengePhase, accountId: string, now: Date) {
    const today = dayIn(now, this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true }));
    return {
      phase,
      accountId,
      phaseStartedAt: now,
      phaseStartDay: today,
      dayKey: today,
      dayStartBalance: row.accountSize,
      dayStartEquity: row.accountSize,
      highWaterEquity: row.accountSize,
      lastMetrics: Prisma.DbNull,
      lastEvaluatedAt: null,
    };
  }
}

const RULE_WORDS: Record<string, string> = {
  DAILY_LOSS: 'The daily loss limit was reached.',
  MAX_LOSS: 'The maximum loss limit was reached.',
  MAX_DAYS: 'The time allowed for this phase ran out.',
};

/** The rules a challenge is held to in its current phase. */
export function termsOf(row: Challenge): ChallengeTerms {
  return {
    profitTargetPct:
      row.phase === 'FUNDED'
        ? null
        : row.phase === 'PHASE_TWO'
          ? (row.phaseTwoTargetPct?.toString() ?? row.phaseOneTargetPct.toString())
          : row.phaseOneTargetPct.toString(),
    dailyLossPct: row.dailyLossPct.toString(),
    maxLossPct: row.maxLossPct.toString(),
    drawdownMode: row.drawdownMode,
    trailingLock: row.trailingLock,
    dailyBasis: row.dailyBasis,
    minTradingDays: row.phase === 'FUNDED' ? 0 : row.minTradingDays,
    maxDays: row.phase === 'FUNDED' ? null : row.maxDays,
  };
}

function checkPlan(input: PlanInput): void {
  const problem =
    termsProblem({
      profitTargetPct: input.phaseOneTargetPct,
      dailyLossPct: input.dailyLossPct,
      maxLossPct: input.maxLossPct,
      drawdownMode: input.drawdownMode,
      trailingLock: input.trailingLock,
      dailyBasis: input.dailyBasis,
      minTradingDays: input.minTradingDays,
      maxDays: input.maxDays,
    }) ??
    (input.steps === 2 && input.phaseTwoTargetPct === null
      ? 'A two-step plan needs a phase 2 target'
      : null) ??
    (input.isActive && input.paymentAddress === null
      ? 'A plan cannot be on sale without a payment address'
      : null);
  if (problem !== null) throw new DomainError(TradingErrorCode.VALIDATION_FAILED, problem);
}

function planData(input: PlanInput) {
  return {
    ...input,
    phaseTwoTargetPct: input.steps === 1 ? null : input.phaseTwoTargetPct,
    accountCurrency: input.accountCurrency.toUpperCase(),
    paymentAsset: input.paymentAsset.toUpperCase(),
  };
}

function planView(row: ChallengePlan, staff: boolean) {
  return {
    id: row.id,
    name: row.name,
    steps: row.steps,
    accountSize: row.accountSize.toString(),
    accountCurrency: row.accountCurrency,
    leverage: row.leverage,
    price: row.price.toString(),
    paymentAsset: row.paymentAsset,
    paymentNetwork: row.paymentNetwork,
    phaseOneTargetPct: row.phaseOneTargetPct.toString(),
    phaseTwoTargetPct: row.phaseTwoTargetPct?.toString() ?? null,
    dailyLossPct: row.dailyLossPct.toString(),
    maxLossPct: row.maxLossPct.toString(),
    drawdownMode: row.drawdownMode,
    trailingLock: row.trailingLock,
    dailyBasis: row.dailyBasis,
    minTradingDays: row.minTradingDays,
    maxDays: row.maxDays,
    profitSplitPct: row.profitSplitPct.toString(),
    ...(staff
      ? {
          paymentAddress: row.paymentAddress,
          isActive: row.isActive,
          createdAt: row.createdAt.toISOString(),
        }
      : {}),
  };
}

function challengeView(
  row: Challenge & {
    account: { number: string } | null;
    certificates: Array<{ code: string; phase: ChallengePhase; issuedAt: Date }>;
  },
) {
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    planName: row.planName,
    steps: row.steps,
    accountSize: row.accountSize.toString(),
    accountCurrency: row.accountCurrency,
    leverage: row.leverage,
    price: row.price.toString(),
    payment: {
      asset: row.paymentAsset,
      network: row.paymentNetwork,
      address: row.paymentAddress,
      transactionHash: row.transactionHash,
    },
    rules: termsOf(row),
    profitSplitPct: row.profitSplitPct.toString(),
    accountId: row.accountId,
    accountNumber: row.account?.number ?? null,
    phaseStartedAt: row.phaseStartedAt?.toISOString() ?? null,
    metrics: row.lastMetrics,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    failedRule: row.failedRule,
    failedAt: row.failedAt?.toISOString() ?? null,
    fundedAt: row.fundedAt?.toISOString() ?? null,
    certificates: row.certificates.map((c) => ({
      code: c.code,
      phase: c.phase,
      issuedAt: c.issuedAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

function metricsJson(metrics: ChallengeMetrics, observed: Record<string, unknown>) {
  return { ...metrics, ...observed } as unknown as Prisma.InputJsonValue;
}

async function event(
  tx: Prisma.TransactionClient,
  row: Challenge,
  kind: string,
  actorId: string | null,
  details: Record<string, unknown>,
  phase: ChallengePhase = row.phase,
  accountId: string | null = row.accountId,
) {
  await tx.challengeEvent.create({
    data: {
      tenantId: requireTenantId(),
      challengeId: row.id,
      kind,
      phase,
      accountId,
      actorId,
      details: details as Prisma.InputJsonValue,
    },
  });
}

/** `PF-` and twelve characters from an alphabet with no look-alikes. */
export function certificateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `PF-${out}`;
}

function notFound(message: string): DomainError {
  return new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, message);
}

function conflict(message: string): DomainError {
  return new DomainError(TradingErrorCode.CONCURRENT_MODIFICATION, message);
}
