import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type WalletTransactionType } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../accounts/ledger.service';
import { AccountStateService } from '../trading/account-state.service';
import { AuditService } from '../common/audit/audit.service';

export interface WalletView {
  readonly id: string;
  readonly currency: string;
  readonly balance: string;
  readonly status: string;
}

export interface WalletMovement {
  readonly walletId: string;
  readonly type: WalletTransactionType;
  /** Signed: positive credits the wallet, negative debits it. */
  readonly amount: Money;
  readonly accountId?: string;
  readonly ledgerEntryId?: string;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly compensatesId?: string;
  readonly idempotencyKey?: string;
  readonly description?: string;
}

export interface MovementResult {
  readonly transactionId: string;
  readonly balanceAfter: Money;
}

/**
 * Money that belongs to a person rather than to a trading account.
 *
 * ## The one design constraint
 *
 * The plan for this phase said it in a line: two ledgers that both believe they
 * are authoritative is the classic way to lose money in an accounting system.
 * These two are not authoritative for the same thing.
 *
 *   * `balance_ledger` — what is *inside a trading account*. `LedgerService` is
 *     its only writer and `accounts.balance` is its cached head.
 *   * `wallet_transactions` — what is held *for a person and in no trading
 *     account*. This service is its only writer and `wallets.balance` is its
 *     cached head.
 *
 * A transfer writes one row on each side in one transaction and the two amounts
 * sum to zero. That is the invariant, and `wallet.test.ts` checks it by adding
 * both pots up before and after every movement it makes.
 *
 * ## What this service will not do
 *
 * It will not convert currencies. A wallet is per-currency, and moving money
 * between a EUR wallet and a USD account at a rate this service picked would put
 * an exchange desk inside a ledger. Transfers between different currencies are
 * refused; the conversion belongs somewhere it can be priced, quoted and
 * recorded as its own transaction.
 */
@Injectable()
export class WalletService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AccountStateService) private readonly state: AccountStateService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * The wallet for this person and currency, created if it is not there.
   *
   * Created lazily rather than at registration, because a person who never
   * deposits should not have a row saying they hold nothing — and because a
   * currency is only known once there is money or an account in it.
   */
  async ensure(userId: string, currency: string): Promise<WalletView> {
    const existing = await this.prisma.wallet.findFirst({ where: { userId, currency } });
    if (existing !== null) return view(existing);

    /**
     * Read-then-write is a race, and `(user_id, currency)` is unique.
     *
     * Two things can ask for the same wallet at the same instant — a webhook
     * crediting a deposit while the person has the wallet page open is enough —
     * and the loser of that race used to get a constraint violation thrown at
     * it. In the payment path that surfaced as a *payment* that failed, which
     * is the worst possible reading of "someone else created your wallet first".
     *
     * The insert stays optimistic rather than becoming an upsert: the common
     * case is that the wallet already exists, and this way it costs one read.
     */
    try {
      const created = await this.prisma.wallet.create({
        data: { tenantId: requireTenantId(), userId, currency },
      });
      return view(created);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const raced = await this.prisma.wallet.findFirst({ where: { userId, currency } });
      if (raced === null) {
        // The unique index fired but the row is not visible: that is not a race,
        // it is something wrong, and it must not be reported as a wallet.
        throw error;
      }
      return view(raced);
    }
  }

  async list(userId: string): Promise<readonly WalletView[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { currency: 'asc' },
    });
    return wallets.map(view);
  }

  async transactions(walletId: string, limit = 100): Promise<readonly unknown[]> {
    return this.prisma.walletTransaction.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * Append one movement. Requires a caller's transaction, for the same reason
   * `LedgerService.post` does: a wallet movement is never the only thing
   * happening, and all of it commits together or none of it does.
   *
   * The rounding rule is the ledger's, and it is not a stylistic echo. Storing
   * `amount.round()` and separately computing `(before + amount).round()` rounds
   * twice and the two disagree whenever the movement does not land on a cent —
   * which is how the balance ledger once drifted a cent per trade. Round once,
   * apply what was rounded.
   */
  async post(tx: Prisma.TransactionClient, movement: WalletMovement): Promise<MovementResult> {
    /**
     * The lock comes before the idempotency check, and the order is the point.
     *
     * Checking first and locking after is a read-then-write: two deliveries of
     * the same webhook both find no movement, both try to write one, and the
     * loser hits the unique index on `idempotency_key`. No money is created —
     * its transaction rolls back — but the caller gets a constraint violation
     * where it asked a question with a correct answer, and a payment provider
     * reading that as a failure will re-deliver the event for hours.
     *
     * Taking the row lock first makes the second caller wait for the first to
     * commit, so it *sees* the movement and returns it. It costs nothing: this
     * lock is taken a few lines later in every case anyway.
     */
    const locked = await tx.$queryRaw<
      Array<{ id: string; balance: string; currency: string; status: string }>
    >`
      SELECT id, balance::text AS balance, currency, status::text AS status
      FROM wallets
      WHERE id = ${movement.walletId}::uuid
      FOR UPDATE
    `;
    const wallet = locked[0];
    if (wallet === undefined) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Wallet not found', {
        walletId: movement.walletId,
      });
    }

    if (movement.idempotencyKey !== undefined) {
      // Per tenant: the key comes from the caller's `Idempotency-Key`, so it
      // is only unique within the firm that chose it. See ledger.service.ts.
      const existing = await tx.walletTransaction.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: requireTenantId(),
            idempotencyKey: movement.idempotencyKey,
          },
        },
      });
      if (existing !== null) {
        /**
         * A replay, answered with what the original did. Not re-posted, and not
         * refused either: the caller asked for one movement and there is one.
         */
        return {
          transactionId: existing.id,
          balanceAfter: Money.of(existing.balanceAfter.toString(), existing.currency),
        };
      }
    }
    if (wallet.status === 'FROZEN') {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This wallet is frozen. Money in it is held, not taken; it moves again when the hold is lifted.',
        { walletId: wallet.id },
      );
    }
    if (movement.amount.currency !== wallet.currency) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Cannot post a ${movement.amount.currency} movement to a ${wallet.currency} wallet`,
        { movementCurrency: movement.amount.currency, walletCurrency: wallet.currency },
      );
    }

    const amount = movement.amount.round();
    const before = Money.of(wallet.balance, wallet.currency);
    const after = before.plus(amount);

    /**
     * A wallet may not go negative.
     *
     * A trading account can — a gap through a stop leaves a debit balance, and
     * pretending otherwise would hide it. A wallet is different: nothing about
     * it is leveraged, so a negative balance there is always an arithmetic
     * mistake or a double spend, never a market event.
     */
    if (after.isNegative()) {
      throw new DomainError(
        TradingErrorCode.INSUFFICIENT_MARGIN,
        `Your ${wallet.currency} wallet holds ${before.toString()}, and this would leave it at ` +
          `${after.toString()}. Wallets are per-currency and cannot go negative — money in another ` +
          'currency is a separate wallet.',
        { balance: before.toString(), requested: amount.toString(), currency: wallet.currency },
      );
    }

    const created = await tx.walletTransaction.create({
      data: {
        tenantId: requireTenantId(),
        walletId: wallet.id,
        type: movement.type,
        amount: amount.toString(),
        balanceAfter: after.toString(),
        currency: wallet.currency,
        accountId: movement.accountId ?? null,
        ledgerEntryId: movement.ledgerEntryId ?? null,
        referenceType: movement.referenceType ?? null,
        referenceId: movement.referenceId ?? null,
        compensatesId: movement.compensatesId ?? null,
        idempotencyKey: movement.idempotencyKey ?? null,
        description: movement.description ?? null,
      },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: after.toString(), version: { increment: 1 } },
    });

    return { transactionId: created.id, balanceAfter: after };
  }

  /**
   * Move money between a person's wallet and one of their trading accounts.
   *
   * ## Lock ordering
   *
   * The account's row lock is taken first, always, before the wallet's. Two
   * transfers on the same pair in opposite directions would otherwise each hold
   * one lock and wait for the other, and PostgreSQL would break the cycle by
   * killing one with `40P01` — reported to the trader as an unexpected error.
   * `LedgerService.lockAccount` already has to be the first statement of any
   * transaction that posts to the ledger, for a related reason it documents; the
   * wallet slots in behind it.
   *
   * ## Why money cannot be created here
   *
   * The two rows are written with equal and opposite amounts, in one
   * transaction. There is no path through this method that writes one without
   * the other, which is why the sum of the two pots is the same afterwards.
   *
   * ## What limits an outbound transfer
   *
   * Free margin, not balance. A trading account's balance includes money that is
   * currently margin for an open position, and letting that leave would close
   * somebody's position for them — from the wallet, silently, at a price nobody
   * chose. `AccountStateService.valuate` is the same computation the terminal
   * shows, so the number the trader was refused against is the number they were
   * looking at.
   */
  async transfer(input: {
    readonly userId: string;
    readonly accountId: string;
    readonly direction: 'to-account' | 'to-wallet';
    /**
     * A decimal string, and the currency is the account's.
     *
     * The caller does not name a currency, because there is no answer they could
     * give that would be right: a transfer is one pot to another, and both pots
     * are in the account's currency by construction — `ensure` is called with
     * it. Letting a client say "EUR" would only create the opportunity to say
     * the wrong one.
     */
    readonly amount: string;
    readonly idempotencyKey: string;
    readonly actorId: string;
  }): Promise<{ readonly wallet: WalletView; readonly accountBalance: string }> {
    const account = await this.prisma.account.findFirst({ where: { id: input.accountId } });
    if (account === null || account.userId !== input.userId) {
      // Not-found rather than forbidden: a forbidden confirms the account
      // exists, which tells somebody their guessed id was right.
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId: input.accountId,
      });
    }

    const amount = Money.of(input.amount, account.currency);
    if (!amount.isPositive()) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A transfer amount must be positive. Use the other direction rather than a negative amount.',
        { amount: input.amount },
      );
    }
    if (account.status !== 'ACTIVE' && input.direction === 'to-account') {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        `This account is ${account.status}. Money can still be taken out of it, but not put in.`,
        { status: account.status },
      );
    }

    const wallet = await this.ensure(input.userId, account.currency);

    const toAccount = input.direction === 'to-account';
    if (!toAccount) {
      const { state } = await this.state.valuate(input.accountId);
      if (amount.gt(state.freeMargin)) {
        throw new DomainError(
          TradingErrorCode.INSUFFICIENT_MARGIN,
          `Only ${state.freeMargin.toString()} ${account.currency} is free. The rest is margin for ` +
            'open positions, and taking it would close them.',
          {
            requested: amount.toString(),
            freeMargin: state.freeMargin.toString(),
            equity: state.equity.toString(),
            usedMargin: state.usedMargin.toString(),
          },
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Account first. See the lock-ordering note above.
      await this.ledger.lockAccount(tx, input.accountId);

      const entry = await this.ledger.post(tx, {
        accountId: input.accountId,
        type: toAccount ? 'DEPOSIT' : 'WITHDRAWAL',
        amount: toAccount ? amount : amount.negated(),
        referenceType: 'WalletTransfer',
        idempotencyKey: `wallet-transfer:ledger:${input.idempotencyKey}`,
        description: toAccount ? 'Transferred from wallet' : 'Transferred to wallet',
      });

      const movement = await this.post(tx, {
        walletId: wallet.id,
        type: toAccount ? 'TRANSFER_OUT' : 'TRANSFER_IN',
        amount: toAccount ? amount.negated() : amount,
        accountId: input.accountId,
        ledgerEntryId: entry.entryId,
        referenceType: 'WalletTransfer',
        idempotencyKey: `wallet-transfer:wallet:${input.idempotencyKey}`,
        description: toAccount
          ? 'Transferred to trading account'
          : 'Transferred from trading account',
      });

      await this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'USER',
          action: toAccount ? 'wallet.transfer.out' : 'wallet.transfer.in',
          resourceType: 'Wallet',
          resourceId: wallet.id,
          after: {
            accountId: input.accountId,
            amount: amount.toString(),
            currency: account.currency,
            walletBalance: movement.balanceAfter.toString(),
            accountBalance: entry.balanceAfter.toString(),
            ledgerEntryId: entry.entryId,
            walletTransactionId: movement.transactionId,
          },
        },
        tx,
      );

      return {
        wallet: { ...wallet, balance: movement.balanceAfter.toString() },
        accountBalance: entry.balanceAfter.toString(),
      };
    });
  }

  /**
   * Record that money arrived from outside, or correct a mistake.
   *
   * There is no payment provider yet, and this is not pretending to be one. It
   * is the manual path every firm has anyway: an operator sees a bank transfer
   * land and records it, under a capability nobody holds by default and which no
   * role may hold alongside the ability to open a position.
   *
   * A correction names the movement it reverses. The original row is never
   * touched — `wallet_transactions` has the same append-only trigger the balance
   * ledger does, and "fixing" history in a financial record destroys what an
   * auditor needs.
   */
  async adjust(input: {
    readonly walletId: string;
    readonly type: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'FEE';
    /**
     * A decimal string in the wallet's own currency. Signed only for
     * ADJUSTMENT; the others take their direction from their type, so a
     * WITHDRAWAL of "-50" is a mistake rather than a credit.
     */
    readonly amount: string;
    readonly reason: string;
    readonly compensatesId?: string;
    readonly idempotencyKey: string;
    readonly actorId: string;
  }): Promise<WalletView> {
    if (input.reason.trim().length < 3) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A reason is required, and it is the only part of this record a person will read later.',
      );
    }

    const wallet = await this.prisma.wallet.findFirst({ where: { id: input.walletId } });
    if (wallet === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Wallet not found');
    }
    const magnitude = Money.of(input.amount, wallet.currency);
    if (input.type !== 'ADJUSTMENT' && !magnitude.isPositive()) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A ${input.type} takes a positive amount; its direction comes from its type.`,
      );
    }

    const signed =
      input.type === 'WITHDRAWAL' || input.type === 'FEE' ? magnitude.negated() : magnitude;

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.wallet.findFirst({ where: { id: input.walletId } });
      if (before === null) {
        throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Wallet not found');
      }

      const movement = await this.post(tx, {
        walletId: input.walletId,
        type: input.type,
        amount: signed,
        ...(input.compensatesId === undefined ? {} : { compensatesId: input.compensatesId }),
        idempotencyKey: input.idempotencyKey,
        description: input.reason.trim(),
      });

      await this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'ADMIN',
          action: `wallet.${input.type.toLowerCase()}`,
          resourceType: 'Wallet',
          resourceId: input.walletId,
          before: { balance: before.balance.toString() },
          after: {
            balance: movement.balanceAfter.toString(),
            amount: signed.toString(),
            reason: input.reason.trim(),
            transactionId: movement.transactionId,
          },
        },
        tx,
      );

      return {
        id: before.id,
        currency: before.currency,
        balance: movement.balanceAfter.toString(),
        status: before.status,
      };
    });
  }

  /**
   * Freeze or release a wallet.
   *
   * Freezing holds money; it does not take it. The two are different acts and
   * the audit trail should be able to say which happened, which is why this
   * capability and `wallet.adjust` are separate and why a risk manager has only
   * the first.
   */
  async setStatus(input: {
    readonly walletId: string;
    readonly status: 'ACTIVE' | 'FROZEN';
    readonly reason: string;
    readonly actorId: string;
  }): Promise<WalletView> {
    if (input.reason.trim().length < 3) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'A reason is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.wallet.findFirst({ where: { id: input.walletId } });
      if (before === null) {
        throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Wallet not found');
      }
      const after = await tx.wallet.update({
        where: { id: input.walletId },
        data: { status: input.status, version: { increment: 1 } },
      });
      await this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'ADMIN',
          action: input.status === 'FROZEN' ? 'wallet.frozen' : 'wallet.released',
          resourceType: 'Wallet',
          resourceId: input.walletId,
          before: { status: before.status },
          after: { status: after.status, reason: input.reason.trim() },
        },
        tx,
      );
      return view(after);
    });
  }
}

/**
 * One shape for a balance, on every path out of this service.
 *
 * The column is `NUMERIC(28,10)`, so Prisma hands back `490.0000000000`, while a
 * `Money` prints `490.00` — the currency's own minor units, and `490` for JPY,
 * which has none. Both are correct and returning whichever happened to be at
 * hand is not: `GET /wallet` and the response to a transfer were reporting the
 * same field in two formats, and a client that formatted one would have got the
 * other wrong. Everything goes through `Money`.
 */
function view(wallet: {
  id: string;
  currency: string;
  balance: { toString(): string };
  status: string;
}): WalletView {
  return {
    id: wallet.id,
    currency: wallet.currency,
    balance: Money.of(wallet.balance.toString(), wallet.currency).toString(),
    status: wallet.status,
  };
}
