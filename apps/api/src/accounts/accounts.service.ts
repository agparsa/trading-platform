import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountType, Prisma } from '@prisma/client';
import { Money, toDecimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';
import type { Env } from '../config/env.schema';

export interface AccountSummary {
  id: string;
  number: string;
  type: AccountType;
  status: string;
  currency: string;
  balance: string;
  leverage: number;
  createdAt: string;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Opens an account.
   *
   * A demo account's opening funds are posted as a real `DEPOSIT` ledger entry,
   * not written straight onto `accounts.balance`. Virtual money is still money
   * as far as this system's bookkeeping is concerned: if the balance did not
   * come from the ledger, reconciliation would flag it forever.
   */
  async openAccount(
    tx: Prisma.TransactionClient,
    userId: string,
    options: { type: AccountType; currency?: string; leverage?: number } = { type: 'DEMO' },
  ): Promise<AccountSummary> {
    // getOrThrow rather than get: these have schema defaults, so a missing
    // value means the config was not validated, and opening an account with an
    // undefined currency is not a failure to paper over.
    const currency = (
      options.currency ?? this.config.getOrThrow('DEFAULT_ACCOUNT_CURRENCY', { infer: true })
    ).toUpperCase();
    const leverage =
      options.leverage ?? this.config.getOrThrow('DEFAULT_ACCOUNT_LEVERAGE', { infer: true });

    const number = await this.nextAccountNumber(tx);

    const account = await tx.account.create({
      data: {
        userId,
        number,
        type: options.type,
        currency,
        leverage,
        balance: '0',
        settings: { create: {} },
      },
    });

    const initial = this.config.get('DEMO_ACCOUNT_INITIAL_BALANCE', { infer: true });
    if (options.type === 'DEMO' && toDecimal(initial).gt(0)) {
      await this.ledger.post(tx, {
        accountId: account.id,
        type: 'DEPOSIT',
        amount: Money.of(initial, currency),
        referenceType: 'ACCOUNT_OPENING',
        referenceId: account.id,
        idempotencyKey: `account-opening:${account.id}`,
        description: 'Demo account opening balance',
      });
    }

    const created = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
    return this.toSummary(created);
  }

  async listForUser(userId: string): Promise<AccountSummary[]> {
    const accounts = await this.prisma.account.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((account) => this.toSummary(account));
  }

  /**
   * Loads one account, scoped to its owner.
   *
   * A caller who does not own the account gets `RESOURCE_NOT_FOUND`, not
   * `FORBIDDEN` — telling an attacker that an account id exists but belongs to
   * someone else is an information leak, and account ids are enumerable targets.
   */
  async getForUser(userId: string, accountId: string): Promise<AccountSummary> {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId } });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId,
      });
    }
    return this.toSummary(account);
  }

  async getSettings(userId: string, accountId: string) {
    await this.getForUser(userId, accountId);
    const settings = await this.prisma.accountSettings.findUniqueOrThrow({
      where: { accountId },
    });
    return {
      marginCallLevelPercent: settings.marginCallLevelPercent.toString(),
      stopOutLevelPercent: settings.stopOutLevelPercent.toString(),
      maxPositionVolume: settings.maxPositionVolume?.toString() ?? null,
      maxOpenPositions: settings.maxOpenPositions,
      maxGrossNotional: settings.maxGrossNotional?.toString() ?? null,
      maxSymbolNetVolume: settings.maxSymbolNetVolume?.toString() ?? null,
    };
  }

  async listLedger(userId: string, accountId: string, limit: number, cursor?: string) {
    await this.getForUser(userId, accountId);
    const entries = await this.prisma.balanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    const page = entries.slice(0, limit);
    return {
      entries: page.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: Money.of(entry.amount.toString(), entry.currency).toString(),
        balanceAfter: Money.of(entry.balanceAfter.toString(), entry.currency).toString(),
        currency: entry.currency,
        description: entry.description,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: entries.length > limit ? page[page.length - 1]?.id : undefined,
    };
  }

  /**
   * Allocates the next public account number from a Postgres sequence.
   *
   * A sequence rather than `count(*) + 1` or a random draw: sequences are
   * collision-free under concurrency and never reuse a value, even if the
   * surrounding transaction rolls back.
   */
  private async nextAccountNumber(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
      SELECT nextval('account_number_seq') AS value
    `;
    const value = rows[0]?.value;
    if (value === undefined) throw new Error('account_number_seq returned no value');
    return `TP-${value.toString()}`;
  }

  private toSummary(account: {
    id: string;
    number: string;
    type: AccountType;
    status: string;
    currency: string;
    balance: Prisma.Decimal;
    leverage: number;
    createdAt: Date;
  }): AccountSummary {
    return {
      id: account.id,
      number: account.number,
      type: account.type,
      status: account.status,
      currency: account.currency,
      balance: Money.of(account.balance.toString(), account.currency).toString(),
      leverage: account.leverage,
      createdAt: account.createdAt.toISOString(),
    };
  }
}
