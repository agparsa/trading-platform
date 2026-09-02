import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '@tp/financial-core';
import { WithdrawalStatus, canTransition } from '@tp/withdrawals-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { SecretDecryptionError } from '@tp/crypto-core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import { NotificationsService } from '../notifications/notifications.service';
import { KycService } from '../kyc/kyc.service';
import { WithdrawalsService, destinationSealContext } from './withdrawals.service';

export interface AdminWithdrawalRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly walletId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly destinationHint: string;
  readonly reason: string | null;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly autoApproved: boolean;
  readonly reviewerId: string | null;
  readonly approvedById: string | null;
  readonly paidById: string | null;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly decidedAt: string | null;
  /** Whether the person is verified *now*, so a reviewer sees it beside the request. */
  readonly identityVerified: boolean;
}

/**
 * Withdrawals, as the finance desk works them.
 *
 * ## Who may do what, and why it is split this way
 *
 * `withdrawals.review` approves and rejects. `withdrawals.pay` starts a payout
 * and records the outcome. Neither may sit in a role beside `payments.confirm`,
 * `wallet.adjust` or `accounts.adjust` — the capabilities that create money —
 * because "confirm a deposit that never arrived, then approve its withdrawal"
 * is the whole of the fraud, and it must take two people. That is what the
 * FINANCE role is for, and why ADMIN does not hold these.
 *
 * ## What "paid" means
 *
 * A statement of fact by a person who sent the money: this transfer, this
 * reference. There is no automated rail here, deliberately — see
 * `PayoutProvider` in `@tp/withdrawals-core` — so PROCESSING means "somebody
 * has started the transfer" and PAID means "and it went". The reference is
 * required, because a payout with no reference is a payout nobody can find on
 * a statement.
 */
@Injectable()
export class AdminWithdrawalsService {
  private readonly logger = new Logger(AdminWithdrawalsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecretBoxService) private readonly secrets: SecretBoxService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  async queue(input: { status?: string; limit?: number }): Promise<readonly AdminWithdrawalRow[]> {
    const known = Object.values(WithdrawalStatus) as string[];
    if (input.status !== undefined && !known.includes(input.status)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `No withdrawal status called ${input.status}. Try one of: ${known.join(', ')}.`,
      );
    }
    const rows = await this.prisma.withdrawalRequest.findMany({
      where:
        input.status === undefined
          ? {
              status: {
                in: [
                  WithdrawalStatus.REQUESTED,
                  WithdrawalStatus.UNDER_REVIEW,
                  WithdrawalStatus.APPROVED,
                  WithdrawalStatus.PROCESSING,
                ],
              },
            }
          : { status: input.status as WithdrawalStatus },
      // Oldest first: a queue is worked in the order people joined it.
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(input.limit ?? 100, 1), 200),
      include: { user: { select: { email: true } } },
    });
    const verified = new Map<string, boolean>();
    for (const row of rows) {
      if (!verified.has(row.userId))
        verified.set(row.userId, await this.kyc.isVerified(row.userId));
    }
    return rows.map((row) => toRow(row, verified.get(row.userId) ?? false));
  }

  async get(id: string): Promise<AdminWithdrawalRow> {
    const row = await this.prisma.withdrawalRequest.findFirst({
      where: { id },
      include: { user: { select: { email: true } } },
    });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such withdrawal');
    }
    return toRow(row, await this.kyc.isVerified(row.userId));
  }

  /**
   * Opens the destination, for the person who is about to pay it.
   *
   * Audited before it is returned, like an identity document, and for the same
   * reason: where somebody's money goes is theirs, and the record of who looked
   * is the platform's to keep.
   */
  async openDestination(input: { id: string; actorId: string }): Promise<{ destination: string }> {
    const row = await this.requireRow(input.id);
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'ADMIN',
          action: 'withdrawal.destination.viewed',
          resourceType: 'WithdrawalRequest',
          resourceId: row.id,
          after: { status: row.status },
        },
        tx,
      ),
    );
    try {
      return { destination: this.secrets.open(row.destination, destinationSealContext(row.id)) };
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        this.logger.error(
          `Withdrawal ${row.id}: destination could not be opened: ${error.message}`,
        );
        throw new DomainError(
          TradingErrorCode.INTERNAL_ERROR,
          'The destination cannot be opened. The sealing key it was written under may have been retired; see docs/encryption-at-rest.md.',
        );
      }
      throw error;
    }
  }

  async claim(input: { id: string; actorId: string }): Promise<AdminWithdrawalRow> {
    const row = await this.requireRow(input.id);
    if (row.status === WithdrawalStatus.UNDER_REVIEW && row.reviewerId === input.actorId) {
      return this.get(row.id);
    }
    this.requireTransition(row.status as WithdrawalStatus, WithdrawalStatus.UNDER_REVIEW);
    await this.move(row, { status: WithdrawalStatus.UNDER_REVIEW, reviewerId: input.actorId });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'withdrawal.review.started',
      resourceType: 'WithdrawalRequest',
      resourceId: row.id,
      before: { status: row.status },
      after: { status: WithdrawalStatus.UNDER_REVIEW, reviewerId: input.actorId },
    });
    return this.get(row.id);
  }

  async release(input: { id: string; actorId: string }): Promise<AdminWithdrawalRow> {
    const row = await this.requireRow(input.id);
    this.requireTransition(row.status as WithdrawalStatus, WithdrawalStatus.REQUESTED);
    await this.move(row, { status: WithdrawalStatus.REQUESTED, reviewerId: null });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'withdrawal.review.released',
      resourceType: 'WithdrawalRequest',
      resourceId: row.id,
      before: { status: row.status },
      after: { status: WithdrawalStatus.REQUESTED },
    });
    return this.get(row.id);
  }

  /**
   * Yes, or no with a reason.
   *
   * A rejection gives the money back, in the same transaction as the status
   * change, through the one release path every ending shares. An approval moves
   * nothing: the money is already held, and stays held until a person pays it.
   */
  async decide(input: {
    readonly id: string;
    readonly outcome: 'APPROVED' | 'REJECTED';
    readonly reason: string;
    readonly actorId: string;
  }): Promise<AdminWithdrawalRow> {
    const row = await this.requireRow(input.id);
    this.requireTransition(row.status as WithdrawalStatus, input.outcome);

    if (input.outcome === WithdrawalStatus.REJECTED) {
      await this.withdrawals.release(row, {
        to: WithdrawalStatus.REJECTED,
        reason: input.reason,
        actorId: input.actorId,
        actorType: 'ADMIN',
        action: 'withdrawal.rejected',
      });
      await this.notifications.raise({
        userId: row.userId,
        kind: 'withdrawal.rejected',
        severity: 'WARNING',
        title: 'Your withdrawal was not approved',
        body: `${input.reason} The ${Money.of(row.amount.toString(), row.currency).toString()} ${row.currency} is back in your wallet.`,
      });
      this.logger.log(`Withdrawal ${row.id} rejected`);
      return this.get(row.id);
    }

    /**
     * Approving re-checks identity. The gate was checked at the request; a
     * revocation between then and now is exactly the case a reviewer must not
     * approve through.
     */
    if (
      this.withdrawals.policy().requireVerifiedIdentity &&
      !(await this.kyc.isVerified(row.userId))
    ) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This person is not currently verified. Their verification may have lapsed or been revoked since the request; reject it, or have them verify again first.',
      );
    }

    await this.move(row, {
      status: WithdrawalStatus.APPROVED,
      reviewerId: null,
      approvedById: input.actorId,
      approvedAt: new Date(),
    });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'withdrawal.approved',
      resourceType: 'WithdrawalRequest',
      resourceId: row.id,
      before: { status: row.status },
      after: { status: WithdrawalStatus.APPROVED, reason: input.reason },
    });
    this.logger.log(`Withdrawal ${row.id} approved`);
    return this.get(row.id);
  }

  /** "I have sent it." Moves an approved request to PROCESSING with the transfer's reference. */
  async startPayout(input: {
    readonly id: string;
    readonly providerReference: string;
    readonly actorId: string;
  }): Promise<AdminWithdrawalRow> {
    const row = await this.requireRow(input.id);
    this.requireTransition(row.status as WithdrawalStatus, WithdrawalStatus.PROCESSING);
    await this.move(row, {
      status: WithdrawalStatus.PROCESSING,
      paidById: input.actorId,
      providerReference: input.providerReference,
    });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'withdrawal.payout_started',
      resourceType: 'WithdrawalRequest',
      resourceId: row.id,
      before: { status: row.status },
      after: { status: WithdrawalStatus.PROCESSING, providerReference: input.providerReference },
    });
    return this.get(row.id);
  }

  /** "And it went" — or "and it did not", in which case the money comes back. */
  async settle(input: {
    readonly id: string;
    readonly outcome: 'PAID' | 'FAILED';
    readonly reason: string;
    readonly actorId: string;
  }): Promise<AdminWithdrawalRow> {
    const row = await this.requireRow(input.id);
    this.requireTransition(row.status as WithdrawalStatus, input.outcome);

    if (input.outcome === WithdrawalStatus.FAILED) {
      await this.withdrawals.release(row, {
        to: WithdrawalStatus.FAILED,
        reason: input.reason,
        actorId: input.actorId,
        actorType: 'ADMIN',
        action: 'withdrawal.failed',
      });
      await this.notifications.raise({
        userId: row.userId,
        kind: 'withdrawal.failed',
        severity: 'WARNING',
        title: 'Your withdrawal could not be paid',
        body: `${input.reason} The money is back in your wallet; check the destination and request again.`,
      });
      this.logger.warn(`Withdrawal ${row.id} failed at payout`);
      return this.get(row.id);
    }

    await this.move(row, {
      status: WithdrawalStatus.PAID,
      paidById: input.actorId,
      decidedAt: new Date(),
    });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'withdrawal.paid',
      resourceType: 'WithdrawalRequest',
      resourceId: row.id,
      before: { status: row.status },
      after: {
        status: WithdrawalStatus.PAID,
        amount: row.amount.toString(),
        currency: row.currency,
        providerReference: row.providerReference,
        reason: input.reason,
      },
    });
    await this.notifications.raise({
      userId: row.userId,
      kind: 'withdrawal.paid',
      severity: 'INFO',
      title: 'Your withdrawal has been paid',
      body: `${Money.of(row.amount.toString(), row.currency).toString()} ${row.currency} was sent to …${row.destinationHint}${row.providerReference === null ? '' : ` (reference ${row.providerReference})`}.`,
    });
    this.logger.log(`Withdrawal ${row.id} paid`);
    return this.get(row.id);
  }

  private async requireRow(id: string) {
    const row = await this.prisma.withdrawalRequest.findFirst({ where: { id } });
    if (row === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such withdrawal');
    }
    return row;
  }

  private requireTransition(from: WithdrawalStatus, to: WithdrawalStatus): void {
    if (!canTransition(from, to)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        `A withdrawal that is ${from} cannot become ${to}.`,
        { from, to },
      );
    }
  }

  private async move(
    row: { id: string; version: number },
    data: {
      status: WithdrawalStatus;
      reviewerId?: string | null;
      approvedById?: string | null;
      approvedAt?: Date | null;
      paidById?: string | null;
      providerReference?: string | null;
      decidedAt?: Date | null;
    },
  ): Promise<void> {
    const updated = await this.prisma.withdrawalRequest.updateMany({
      where: { id: row.id, version: row.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new DomainError(
        TradingErrorCode.CONCURRENT_MODIFICATION,
        'Somebody else changed this withdrawal first. Reload and look again.',
      );
    }
  }
}

function toRow(
  row: {
    id: string;
    userId: string;
    user: { email: string };
    walletId: string;
    amount: { toString(): string };
    currency: string;
    status: string;
    destinationHint: string;
    reason: string | null;
    provider: string;
    providerReference: string | null;
    autoApproved: boolean;
    reviewerId: string | null;
    approvedById: string | null;
    paidById: string | null;
    createdAt: Date;
    approvedAt: Date | null;
    decidedAt: Date | null;
  },
  identityVerified: boolean,
): AdminWithdrawalRow {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    walletId: row.walletId,
    amount: Money.of(row.amount.toString(), row.currency).toString(),
    currency: row.currency,
    status: row.status,
    destinationHint: row.destinationHint,
    reason: row.reason,
    provider: row.provider,
    providerReference: row.providerReference,
    autoApproved: row.autoApproved,
    reviewerId: row.reviewerId,
    approvedById: row.approvedById,
    paidById: row.paidById,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    identityVerified,
  };
}
