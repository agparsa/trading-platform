import { Injectable } from '@nestjs/common';
import type { LedgerEntryType, Prisma } from '@prisma/client';
import { Money, toDecimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';

export interface LedgerPosting {
  readonly accountId: string;
  readonly type: LedgerEntryType;
  /** Signed: positive credits the account, negative debits it. */
  readonly amount: Money;
  readonly referenceType?: string;
  readonly referenceId?: string;
  /** Makes the posting safe to retry. Unique across the whole ledger. */
  readonly idempotencyKey?: string;
  readonly description?: string;
  /** Set on an ADJUSTMENT that reverses an earlier entry. */
  readonly compensatesId?: string;
}

export interface LedgerResult {
  readonly entryId: string;
  readonly balanceAfter: Money;
}

/**
 * The only writer of account balances.
 *
 * Nothing else in the platform may update `accounts.balance`. Every change is an
 * append-only ledger entry, and the account row is a cache of the latest
 * `balanceAfter` maintained inside the same transaction.
 *
 * Every method requires a caller-supplied transaction client. A balance change
 * is never the only thing happening — it accompanies an order, an execution, a
 * position close — and all of it commits together or none of it does.
 */
@Injectable()
export class LedgerService {
  /**
   * Append one entry.
   *
   * The account row is locked `FOR UPDATE` before the balance is read. Without
   * the lock, two concurrent postings would both read the same starting balance
   * and the second would overwrite the first — the classic lost update, and in
   * this table it means money that silently never existed.
   */
  async post(tx: Prisma.TransactionClient, posting: LedgerPosting): Promise<LedgerResult> {
    if (posting.idempotencyKey !== undefined) {
      const existing = await tx.balanceLedger.findUnique({
        where: { idempotencyKey: posting.idempotencyKey },
      });
      if (existing !== null) {
        // Already posted. Return the original result rather than double-crediting.
        return {
          entryId: existing.id,
          balanceAfter: Money.of(existing.balanceAfter.toString(), existing.currency),
        };
      }
    }

    const locked = await tx.$queryRaw<Array<{ id: string; balance: string; currency: string }>>`
      SELECT id, balance::text AS balance, currency
      FROM accounts
      WHERE id = ${posting.accountId}::uuid
      FOR UPDATE
    `;
    const account = locked[0];
    if (account === undefined) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId: posting.accountId,
      });
    }

    if (posting.amount.currency !== account.currency) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Cannot post a ${posting.amount.currency} entry to a ${account.currency} account`,
        { entryCurrency: posting.amount.currency, accountCurrency: account.currency },
      );
    }

    const before = Money.of(account.balance, account.currency);
    const after = before.plus(posting.amount).round();

    const entry = await tx.balanceLedger.create({
      data: {
        accountId: posting.accountId,
        type: posting.type,
        amount: posting.amount.round().toString(),
        balanceAfter: after.toString(),
        currency: account.currency,
        referenceType: posting.referenceType ?? null,
        referenceId: posting.referenceId ?? null,
        compensatesId: posting.compensatesId ?? null,
        idempotencyKey: posting.idempotencyKey ?? null,
        description: posting.description ?? null,
      },
    });

    await tx.account.update({
      where: { id: posting.accountId },
      data: { balance: after.toString(), version: { increment: 1 } },
    });

    return { entryId: entry.id, balanceAfter: after };
  }

  /**
   * Reverse an earlier entry with a compensating one.
   *
   * The original row is never touched. "Correcting" history in a financial
   * ledger destroys the very record an auditor needs.
   */
  async compensate(
    tx: Prisma.TransactionClient,
    entryId: string,
    reason: string,
  ): Promise<LedgerResult> {
    const original = await tx.balanceLedger.findUnique({ where: { id: entryId } });
    if (original === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Ledger entry not found', {
        entryId,
      });
    }
    const reversal = Money.of(original.amount.toString(), original.currency).negated();
    return this.post(tx, {
      accountId: original.accountId,
      type: 'ADJUSTMENT',
      amount: reversal,
      referenceType: original.referenceType ?? undefined,
      referenceId: original.referenceId ?? undefined,
      compensatesId: original.id,
      description: reason,
    });
  }

  /**
   * Recompute a balance by replaying every entry.
   *
   * The reconciliation check: if this disagrees with `accounts.balance`, the
   * ledger is right and the cache is wrong. Used by the scheduled job and
   * available to support when a balance is disputed.
   */
  async replayBalance(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<{ replayed: Money; stored: Money; matches: boolean }> {
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId,
      });
    }
    const entries = await tx.balanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      select: { amount: true },
    });
    let total = toDecimal(0);
    for (const entry of entries) total = total.plus(toDecimal(entry.amount.toString()));

    const replayed = Money.of(total, account.currency).round();
    const stored = Money.of(account.balance.toString(), account.currency).round();
    return { replayed, stored, matches: replayed.equals(stored) };
  }
}
