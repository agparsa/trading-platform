import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Money } from '@tp/financial-core';
import {
  COUNTS_TOWARD_LIMITS,
  WithdrawalStatus,
  cancellableByRequester,
  needsHumanApproval,
  refusalsFor,
  type Refusal,
  type WithdrawalPolicy,
} from '@tp/withdrawals-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { destinationSealContext } from '@tp/crypto-core';
import { requireTenantId } from '@tp/tenancy';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import { WalletService } from '../wallet/wallet.service';
import { KycService } from '../kyc/kyc.service';

export interface WithdrawalView {
  readonly id: string;
  readonly walletId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  /** The tail of the destination, for recognising it. Never the whole thing. */
  readonly destinationHint: string;
  readonly reason: string | null;
  readonly providerReference: string | null;
  readonly canCancel: boolean;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly decidedAt: string | null;
}

/** What a person is allowed, stated so the page can say it before a round trip. */
export interface WithdrawalTerms {
  readonly minimum: string;
  readonly maximum: string;
  readonly dailyLimit: string | null;
  readonly remainingToday: string | null;
  readonly cooldownHours: number;
  readonly nextAllowedAt: string | null;
  readonly identityRequired: boolean;
  readonly identityVerified: boolean;
}

/**
 * The AAD a destination is sealed under: its own request and nothing else.
 *
 * Defined in `sealed-columns.ts`, so the rotation job binds it the same way.
 */
export { destinationSealContext };

/**
 * Money leaving a wallet, from the person's side.
 *
 * ## The hold is the design
 *
 * The wallet is debited at the moment of the request. Not at approval, not at
 * payment. A balance that still showed money somebody had asked to withdraw
 * could be moved into a trading account and traded while the bank transfer of
 * the same money was in flight — two claims on one sum, which is the thing a
 * ledger exists to make impossible.
 *
 * So `request` writes the wallet movement and the request row in one
 * transaction, and everything afterwards is about what happens to money that
 * has already left the wallet: it leaves the platform (PAID) or it comes back by
 * a compensating movement (REJECTED, CANCELLED, FAILED). The sum of every wallet
 * plus every open hold is therefore constant across the whole lifecycle, and
 * the integration tests add it up after every step.
 *
 * ## What is refused, and how
 *
 * Every applicable reason at once — `refusalsFor` in `@tp/withdrawals-core` —
 * so a person is not sent round the loop once per limit. Identity is checked
 * first and stops the list: somebody unverified is not being told how much
 * they could withdraw if they were.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecretBoxService) private readonly secrets: SecretBoxService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  policy(): WithdrawalPolicy {
    return {
      minimum: this.config.get('WITHDRAWAL_MIN_AMOUNT', { infer: true }),
      maximum: this.config.get('WITHDRAWAL_MAX_AMOUNT', { infer: true }),
      dailyLimit: this.config.get('WITHDRAWAL_DAILY_LIMIT', { infer: true }) ?? null,
      cooldownHours: this.config.get('WITHDRAWAL_COOLDOWN_HOURS', { infer: true }),
      requireVerifiedIdentity: this.config.get('WITHDRAWAL_REQUIRE_KYC', { infer: true }),
    };
  }

  private async history(userId: string, currency: string, now: Date) {
    const since = new Date(now.getTime() - 86_400_000);
    const recent = await this.prisma.withdrawalRequest.findMany({
      where: {
        userId,
        currency,
        status: { in: [...COUNTS_TOWARD_LIMITS] },
        createdAt: { gte: since },
      },
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    let requestedToday = Money.of('0', currency);
    for (const row of recent) {
      requestedToday = requestedToday.plus(Money.of(row.amount.toString(), currency));
    }
    return {
      requestedToday: requestedToday.toString(),
      lastRequestedAt: recent[0]?.createdAt ?? null,
    };
  }

  /** What this person may withdraw right now, for the page to say up front. */
  async terms(userId: string, currency: string): Promise<WithdrawalTerms> {
    const policy = this.policy();
    const now = new Date();
    const [history, verified] = await Promise.all([
      this.history(userId, currency, now),
      this.kyc.isVerified(userId),
    ]);
    const remaining =
      policy.dailyLimit === null
        ? null
        : Money.of(policy.dailyLimit, currency).minus(Money.of(history.requestedToday, currency));
    const nextAllowedAt =
      policy.cooldownHours > 0 && history.lastRequestedAt !== null
        ? new Date(history.lastRequestedAt.getTime() + policy.cooldownHours * 3_600_000)
        : null;
    return {
      minimum: Money.of(policy.minimum, currency).toString(),
      maximum: Money.of(policy.maximum, currency).toString(),
      dailyLimit:
        policy.dailyLimit === null ? null : Money.of(policy.dailyLimit, currency).toString(),
      remainingToday:
        remaining === null
          ? null
          : (remaining.isPositive() ? remaining : Money.of('0', currency)).toString(),
      cooldownHours: policy.cooldownHours,
      nextAllowedAt:
        nextAllowedAt !== null && nextAllowedAt > now ? nextAllowedAt.toISOString() : null,
      identityRequired: policy.requireVerifiedIdentity,
      identityVerified: verified,
    };
  }

  async list(userId: string, limit = 50): Promise<readonly WithdrawalView[]> {
    const rows = await this.prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(view);
  }

  async get(userId: string, id: string): Promise<WithdrawalView> {
    const row = await this.prisma.withdrawalRequest.findFirst({ where: { id } });
    if (row === null || row.userId !== userId) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such withdrawal');
    }
    return view(row);
  }

  /**
   * Asks for money out, and takes it out of the wallet in the same breath.
   *
   * The wallet's own row lock — inside `WalletService.post` — serialises two
   * requests racing for the same balance: the second waits, re-reads, and is
   * refused by the ledger's own "a wallet may not go negative" rule, whatever
   * `refusalsFor` concluded from the balance it read a moment earlier.
   */
  async request(input: {
    readonly userId: string;
    readonly walletId: string;
    readonly amount: string;
    readonly destination: string;
    readonly idempotencyKey: string;
  }): Promise<WithdrawalView> {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: input.walletId } });
    if (wallet === null || wallet.userId !== input.userId) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such wallet');
    }
    if (wallet.status === 'FROZEN') {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This wallet is frozen while it is reviewed. Nothing can be withdrawn from it until the hold is lifted.',
      );
    }

    const destination = input.destination.trim();
    if (destination.length < 8 || destination.length > 500) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Say where the money should go — an account name and number, or an IBAN — in at least eight characters.',
      );
    }

    const now = new Date();
    const policy = this.policy();
    const [history, verified] = await Promise.all([
      this.history(input.userId, wallet.currency, now),
      this.kyc.isVerified(input.userId),
    ]);
    const refusals = refusalsFor({
      amount: input.amount,
      currency: wallet.currency,
      policy,
      applicant: { identityVerified: verified, available: wallet.balance.toString() },
      history,
      now,
    });
    if (refusals.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        describe(refusals, wallet.currency),
        {
          refusals: refusals.map((one) => one.reason).join(','),
        },
      );
    }

    const amount = Money.of(input.amount, wallet.currency).round();
    const id = randomUUID();
    const autoApproved = !needsHumanApproval(
      amount.toString(),
      wallet.currency,
      this.config.get('WITHDRAWAL_AUTO_APPROVE_BELOW', { infer: true }) ?? null,
    );
    const sealed = this.secrets.seal(destination, destinationSealContext(id));

    const created = await this.prisma.$transaction(async (tx) => {
      /**
       * The hold first, so that if the ledger refuses — insufficient funds
       * after a concurrent request, a frozen wallet — no request row exists to
       * describe money that never moved.
       */
      const hold = await this.wallets.post(tx, {
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        amount: amount.negated(),
        referenceType: 'WithdrawalRequest',
        referenceId: id,
        idempotencyKey: `withdrawal:${id}:hold`,
        description: `Withdrawal requested, to …${hint(destination)}`,
      });

      const row = await tx.withdrawalRequest.create({
        data: {
          id,
          tenantId: requireTenantId(),
          userId: input.userId,
          walletId: wallet.id,
          amount: amount.toString(),
          currency: wallet.currency,
          status: autoApproved ? WithdrawalStatus.APPROVED : WithdrawalStatus.REQUESTED,
          destination: sealed,
          destinationHint: hint(destination),
          holdTransactionId: hold.transactionId,
          autoApproved,
          ...(autoApproved ? { approvedAt: now } : {}),
        },
      });

      await this.audit.record(
        {
          actorId: input.userId,
          actorType: 'USER',
          action: 'withdrawal.requested',
          resourceType: 'WithdrawalRequest',
          resourceId: id,
          after: {
            amount: amount.toString(),
            currency: wallet.currency,
            walletId: wallet.id,
            holdTransactionId: hold.transactionId,
            balanceAfter: hold.balanceAfter.toString(),
            autoApproved,
            // The hint and never the destination: an audit row is read by
            // more people than a payout is made by.
            destinationHint: hint(destination),
          },
        },
        tx,
      );

      return row;
    });

    this.logger.log(
      `Withdrawal ${id} requested: ${amount.toString()} ${wallet.currency}${autoApproved ? ' (auto-approved)' : ''}`,
    );
    return view(created);
  }

  /**
   * The person taking their request back.
   *
   * Only while nobody has decided. After approval it is the firm's to finish or
   * refuse; a person who changes their mind then asks an operator.
   */
  async cancel(input: {
    readonly userId: string;
    readonly id: string;
    readonly idempotencyKey: string;
  }): Promise<WithdrawalView> {
    const row = await this.prisma.withdrawalRequest.findFirst({ where: { id: input.id } });
    if (row === null || row.userId !== input.userId) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such withdrawal');
    }
    if (!cancellableByRequester(row.status as WithdrawalStatus)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        row.status === WithdrawalStatus.APPROVED || row.status === WithdrawalStatus.PROCESSING
          ? 'This withdrawal has been approved and is being paid. Ask support if it should not be.'
          : `This withdrawal is already ${row.status.toLowerCase()}.`,
        { status: row.status },
      );
    }

    await this.release(row, {
      to: WithdrawalStatus.CANCELLED,
      reason: 'Cancelled by the requester',
      actorId: input.userId,
      actorType: 'USER',
      action: 'withdrawal.cancelled',
    });
    return this.get(input.userId, input.id);
  }

  /**
   * Gives the held money back and ends the request.
   *
   * Shared by cancellation, rejection and payout failure — the three endings
   * in which the money did not leave. One compensating movement, keyed on the
   * request id, so a repeat of any of them credits nothing twice; the request
   * row and the movement commit together, or neither does.
   */
  async release(
    row: {
      id: string;
      walletId: string;
      amount: { toString(): string };
      currency: string;
      status: string;
      version: number;
      holdTransactionId: string;
    },
    outcome: {
      readonly to: 'CANCELLED' | 'REJECTED' | 'FAILED';
      readonly reason: string;
      readonly actorId: string;
      readonly actorType: 'USER' | 'ADMIN' | 'SYSTEM';
      readonly action: string;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const back = await this.wallets.post(tx, {
        walletId: row.walletId,
        type: 'ADJUSTMENT',
        amount: Money.of(row.amount.toString(), row.currency),
        referenceType: 'WithdrawalRequest',
        referenceId: row.id,
        compensatesId: row.holdTransactionId,
        idempotencyKey: `withdrawal:${row.id}:release`,
        description: `Withdrawal ${outcome.to.toLowerCase()}: ${outcome.reason}`,
      });

      const updated = await tx.withdrawalRequest.updateMany({
        where: { id: row.id, version: row.version },
        data: {
          status: outcome.to,
          reason: outcome.reason,
          releaseTransactionId: back.transactionId,
          decidedAt: new Date(),
          reviewerId: null,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        // Rolls the compensating movement back with it.
        throw new DomainError(
          TradingErrorCode.CONCURRENT_MODIFICATION,
          'This withdrawal changed while it was being closed. Reload and look again.',
        );
      }

      await this.audit.record(
        {
          actorId: outcome.actorId,
          actorType: outcome.actorType,
          action: outcome.action,
          resourceType: 'WithdrawalRequest',
          resourceId: row.id,
          before: { status: row.status },
          after: {
            status: outcome.to,
            reason: outcome.reason,
            releaseTransactionId: back.transactionId,
            balanceAfter: back.balanceAfter.toString(),
          },
        },
        tx,
      );
    });
  }
}

/** The last four characters, for recognising a destination in a list. */
export function hint(destination: string): string {
  const compact = destination.replace(/\s+/g, '');
  return compact.slice(-4);
}

export function view(row: {
  id: string;
  walletId: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  destinationHint: string;
  reason: string | null;
  providerReference: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  decidedAt: Date | null;
}): WithdrawalView {
  return {
    id: row.id,
    walletId: row.walletId,
    amount: Money.of(row.amount.toString(), row.currency).toString(),
    currency: row.currency,
    status: row.status,
    destinationHint: row.destinationHint,
    reason: row.reason,
    providerReference: row.providerReference,
    canCancel: cancellableByRequester(row.status as WithdrawalStatus),
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** One sentence naming everything wrong, in the order it reads best. */
function describe(refusals: readonly Refusal[], currency: string): string {
  const parts = refusals.map((one) => {
    switch (one.reason) {
      case 'IDENTITY_NOT_VERIFIED':
        return 'your identity has to be verified before money can be paid out — see the Verification page';
      case 'NOT_POSITIVE':
        return 'the amount must be more than zero';
      case 'BELOW_MINIMUM':
        return `the smallest withdrawal is ${one.minimum} ${currency}`;
      case 'ABOVE_MAXIMUM':
        return `the largest single withdrawal is ${one.maximum} ${currency}`;
      case 'INSUFFICIENT_FUNDS':
        return `the wallet holds ${one.available} ${currency}`;
      case 'DAILY_LIMIT':
        return `${one.remaining} ${currency} of the ${one.dailyLimit} ${currency} daily limit remains`;
      case 'COOLDOWN':
        return `the next request can be made at ${one.until.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
    }
  });
  const sentence = parts.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
