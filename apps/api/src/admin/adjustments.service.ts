import { Injectable, Logger } from '@nestjs/common';
import { Money, toDecimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { LedgerService } from '../accounts/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { TotpService } from '../auth/totp.service';

/**
 * Moving money by hand.
 *
 * ## What this is not
 *
 * There is no endpoint anywhere in this platform that sets a balance. §37 is
 * explicit — "do not create arbitrary balance editing; financial adjustments
 * must go through immutable ledger operations" — and the reason is worth stating
 * rather than citing: a balance that can be written directly is a balance whose
 * history is a lie. The ledger would say one thing, the account another, and the
 * only way to tell which was right would be to ask the person who typed it.
 *
 * So an adjustment is an **entry**, not an edit. It appends. The balance moves
 * because the ledger moved, through the same `LedgerService.post` a trade uses,
 * inside the same account lock, and the row it writes can be read back a year
 * later beside the trades either side of it.
 *
 * ## Three things are demanded before it happens
 *
 * 1. **`accounts.adjust`**, which is nobody's by default and is not implied by
 *    being able to suspend an account.
 * 2. **A current TOTP code from the administrator.** Not because the session is
 *    doubted, but because this is the one action in the platform that creates
 *    money, and a session left open on an unlocked machine should not be enough
 *    to do it.
 * 3. **A reason, in words.** Stored on the entry and in the audit record. An
 *    adjustment nobody can explain later is indistinguishable from theft, and
 *    the person it will be hardest for is the honest administrator.
 *
 * ## Idempotency
 *
 * The caller's key becomes the ledger row's `idempotencyKey`, which carries a
 * unique constraint. A retried request cannot credit twice — the second insert
 * loses, and that is enforced by the database rather than by remembering.
 */
@Injectable()
export class AdjustmentsService {
  private readonly logger = new Logger(AdjustmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly totp: TotpService,
  ) {}

  async adjust(
    actorId: string,
    request: {
      accountId: string;
      /** Signed. Positive credits the account, negative debits it. */
      amount: string;
      type: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'FEE';
      reason: string;
      /** A current code from the administrator's authenticator. */
      totpCode: string;
      idempotencyKey: string;
      /** Set when this entry corrects a specific earlier one. */
      compensatesId?: string | null;
    },
  ): Promise<{ entryId: string; balanceAfter: string; amount: string }> {
    const reason = request.reason.trim();
    if (reason.length < 8) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'An adjustment needs a reason somebody can read back later — at least a short sentence.',
      );
    }

    const amount = toDecimal(request.amount);
    if (amount.isZero()) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'An adjustment of zero changes nothing and records a decision that was not made.',
      );
    }

    // Before anything is written. A failed code must not leave a half-done
    // adjustment behind, and the cheapest way to guarantee that is to demand it
    // first.
    await this.totp.consume(actorId, request.totpCode);

    const account = await this.prisma.account.findUnique({
      where: { id: request.accountId },
      select: { id: true, currency: true, status: true, balance: true },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such account', {
        accountId: request.accountId,
      });
    }

    /**
     * A debit that would take the account below zero is refused.
     *
     * A negative cash balance is not a state this platform has rules for — it is
     * not a margin loan, and nothing downstream knows how to charge interest on
     * it or collect it. Refusing is the honest answer; the operator who really
     * means it can post the part that fits and say so.
     */
    if (amount.lt(0) && toDecimal(account.balance.toString()).plus(amount).lt(0)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `That debit would take the account below zero (balance ${account.balance.toString()}, adjustment ${request.amount}).`,
        { balance: account.balance.toString(), amount: request.amount },
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // The same lock a trade takes, in the same order. An adjustment landing
      // between a fill and its ledger write would otherwise compute
      // `balanceAfter` from a balance that was about to change.
      await this.ledger.lockAccount(tx, request.accountId);
      return this.ledger.post(tx, {
        accountId: request.accountId,
        type: request.type,
        amount: Money.of(request.amount, account.currency),
        referenceType: 'admin_adjustment',
        referenceId: actorId,
        idempotencyKey: request.idempotencyKey,
        description: reason,
        ...(request.compensatesId == null ? {} : { compensatesId: request.compensatesId }),
      });
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'account.balance_adjusted',
      resourceType: 'account',
      resourceId: request.accountId,
      before: { balance: account.balance.toString() },
      after: {
        balance: result.balanceAfter.toString(),
        amount: request.amount,
        type: request.type,
        reason,
        ledgerEntryId: result.entryId,
        compensatesId: request.compensatesId ?? null,
      },
    });

    this.logger.warn(
      {
        actorId,
        accountId: request.accountId,
        amount: request.amount,
        entryId: result.entryId,
      },
      'Balance adjusted by an administrator',
    );

    return {
      entryId: result.entryId,
      balanceAfter: result.balanceAfter.toString(),
      amount: request.amount,
    };
  }
}
