import { Injectable, Logger } from '@nestjs/common';
import { Money, toDecimal } from '@tp/financial-core';
import { PrismaService } from '../prisma.service';

export interface AccountDrift {
  readonly accountId: string;
  readonly number: string;
  readonly stored: string;
  readonly replayed: string;
  readonly difference: string;
}

export interface ReconciliationSummary {
  readonly checked: number;
  readonly drifted: AccountDrift[];
}

/**
 * Checks every account's cached balance against a full replay of its ledger.
 *
 * `accounts.balance` is a cache; `balance_ledger` is the record. If they
 * disagree, the ledger is right and something wrote a balance outside the
 * ledger service — the most serious alarm this system can raise, because it
 * means the number a trader is looking at is not backed by an auditable trail.
 *
 * Discrepancies are recorded as risk events rather than silently repaired.
 * Auto-correcting would erase the evidence of how the drift happened.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<ReconciliationSummary> {
    const accounts = await this.prisma.account.findMany({
      select: { id: true, number: true, balance: true, currency: true },
    });

    const drifted: AccountDrift[] = [];

    for (const account of accounts) {
      const entries = await this.prisma.balanceLedger.findMany({
        where: { accountId: account.id },
        select: { amount: true },
      });

      let total = toDecimal(0);
      for (const entry of entries) total = total.plus(toDecimal(entry.amount.toString()));

      const replayed = Money.of(total, account.currency).round();
      const stored = Money.of(account.balance.toString(), account.currency).round();
      if (replayed.equals(stored)) continue;

      const difference = stored.minus(replayed);
      const drift: AccountDrift = {
        accountId: account.id,
        number: account.number,
        stored: stored.toString(),
        replayed: replayed.toString(),
        difference: difference.toString(),
      };
      drifted.push(drift);

      this.logger.error(
        drift,
        'LEDGER DRIFT: the cached balance does not match a replay of the ledger',
      );

      await this.prisma.riskEvent.create({
        data: {
          accountId: account.id,
          rule: 'ledger-reconciliation',
          code: 'LEDGER_DRIFT',
          severity: 'CRITICAL',
          message: `Cached balance ${drift.stored} does not match the ledger replay ${drift.replayed} (difference ${drift.difference})`,
          snapshot: { ...drift },
        },
      });
    }

    if (drifted.length === 0) {
      this.logger.log(`Reconciliation clean: ${accounts.length} account(s) match their ledger`);
    }
    return { checked: accounts.length, drifted };
  }
}
