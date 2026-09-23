import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { Money } from '@tp/financial-core';
import { Permission } from '@tp/shared-types';
import { ConversionService } from '../market/conversion.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStateService } from '../trading/account-state.service';

/** One account as the desk sees it. */
export interface DeskAccountRow {
  readonly accountId: string;
  readonly accountNumber: string;
  readonly currency: string;
  /** What this operator may do to it, so a screen can grey out what it cannot. */
  readonly capabilities: readonly string[];
  readonly balance: string;
  readonly equity: string;
  readonly usedMargin: string;
  readonly freeMargin: string;
  readonly floatingPnl: string;
  readonly marginLevel: string | null;
  readonly openPositions: number;
  /** Present only when this account is not in the desk's own currency. */
  readonly rateToDesk: string | null;
  /** Null when a rate was needed and could not be had. */
  readonly equityInDeskCurrency: string | null;
}

export interface DeskExposureRow {
  readonly symbol: string;
  /** Signed: long positions add, short positions subtract. */
  readonly netVolume: string;
  /** Unsigned, and in the desk's currency, so symbols can be compared. */
  readonly grossNotional: string | null;
  readonly accounts: number;
}

export interface DeskView {
  readonly masterAccountId: string;
  readonly name: string;
  readonly currency: string;
  readonly accounts: readonly DeskAccountRow[];
  readonly exposure: readonly DeskExposureRow[];
  readonly totals: {
    readonly accounts: number;
    readonly balance: string | null;
    readonly equity: string | null;
    readonly usedMargin: string | null;
    readonly floatingPnl: string | null;
    readonly openPositions: number;
    readonly grossNotional: string | null;
  };
  /**
   * Accounts whose figures could not be converted into the desk's currency.
   *
   * Named rather than skipped. A total that quietly drops the account it could
   * not price reads as a smaller book than the desk actually runs, which is
   * the direction that gets someone hurt.
   */
  readonly unpriced: readonly string[];
}

/**
 * A desk's book: what the accounts one master reaches add up to.
 *
 * ## Why this is a read and nothing more
 *
 * A desk is a view over accounts, not a container of them. The money belongs
 * to the account holders; the desk is a person with delegations. So nothing
 * here moves anything, and the totals below are a report — they are not the
 * input to any decision the platform makes. `AccountStateService.valuate` is
 * still the only place equity is computed, and this calls it once per account
 * rather than recomputing anything, so a desk total and an account's own
 * screen cannot disagree.
 *
 * ## Currency
 *
 * A desk can hold accounts in several currencies, and adding a euro balance to
 * a dollar one is meaningless. Every figure is therefore converted into the
 * desk's currency — the currency of the operator's own first account, or USD
 * when they have none — at the current mid rate, and an account that cannot be
 * converted is **named in `unpriced`** and left out of the totals rather than
 * being added at par. Its own row keeps its own currency and is still shown.
 *
 * ## What it does not do
 *
 * It does not aggregate accounts the operator cannot see. The desk is exactly
 * its active links, filtered to those that carry `accounts.read` — a link that
 * grants only `orders.create` is a delegation to trade, not a licence to read
 * the balance.
 */
@Injectable()
export class DeskViewService {
  private readonly logger = new Logger(DeskViewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
    private readonly conversion: ConversionService,
  ) {}

  async view(masterAccountId: string): Promise<DeskView> {
    const master = await this.prisma.masterAccount.findFirst({
      where: { id: masterAccountId },
      select: { id: true, name: true, userId: true, status: true },
    });
    if (master === null) {
      return emptyView(masterAccountId, 'unknown desk', 'USD');
    }

    /**
     * A suspended master reaches nothing — the same predicate
     * `AccountAccessService` uses, so a suspended desk's screen and its
     * refusals agree rather than showing a book it can no longer touch.
     */
    const links =
      master.status === 'ACTIVE'
        ? await this.prisma.masterAccountLink.findMany({
            where: { masterAccountId, status: 'ACTIVE' },
            include: { account: { select: { id: true, number: true, currency: true } } },
          })
        : [];

    const readable = links.filter((link) =>
      link.capabilities.includes(Permission.ACCOUNTS_READ as string),
    );
    const currency = await this.deskCurrency(master.userId, readable[0]?.account.currency);
    if (readable.length === 0) return emptyView(masterAccountId, master.name, currency);

    const accounts: DeskAccountRow[] = [];
    const unpriced: string[] = [];
    const exposure = new Map<
      string,
      { net: Decimal; gross: Decimal | null; accounts: Set<string> }
    >();

    let balance: Money | null = Money.zero(currency);
    let equity: Money | null = Money.zero(currency);
    let usedMargin: Money | null = Money.zero(currency);
    let floating: Money | null = Money.zero(currency);
    let grossNotional: Decimal | null = new Decimal(0);
    let openPositions = 0;

    for (const link of readable) {
      const valuation = await this.accountState.valuate(link.accountId);
      const state = valuation.state;
      const rate = await this.rateTo(state.currency, currency);

      openPositions += valuation.openPositionCount;
      for (const [symbol, one] of valuation.exposureBySymbol) {
        const row = exposure.get(symbol) ?? {
          net: new Decimal(0),
          gross: new Decimal(0),
          accounts: new Set<string>(),
        };
        row.net = row.net.plus(one.netVolume);
        // Notional is money, so it converts — and a symbol with even one
        // unpriceable account reports no notional rather than a partial one.
        row.gross =
          row.gross === null || rate === null
            ? null
            : row.gross.plus(new Decimal(one.grossNotional.toString()).mul(rate));
        row.accounts.add(link.accountId);
        exposure.set(symbol, row);
      }

      if (rate === null) {
        unpriced.push(link.account.number);
        balance = null;
        equity = null;
        usedMargin = null;
        floating = null;
        grossNotional = null;
      } else {
        balance = balance?.plus(convert(state.balance, currency, rate)) ?? null;
        equity = equity?.plus(convert(state.equity, currency, rate)) ?? null;
        usedMargin = usedMargin?.plus(convert(state.usedMargin, currency, rate)) ?? null;
        floating = floating?.plus(convert(state.floatingPnl, currency, rate)) ?? null;
        for (const one of valuation.exposureBySymbol.values()) {
          grossNotional =
            grossNotional?.plus(new Decimal(one.grossNotional.toString()).mul(rate)) ?? null;
        }
      }

      accounts.push({
        accountId: link.accountId,
        accountNumber: link.account.number,
        currency: state.currency,
        capabilities: link.capabilities,
        balance: state.balance.toString(),
        equity: state.equity.toString(),
        usedMargin: state.usedMargin.toString(),
        freeMargin: state.freeMargin.toString(),
        floatingPnl: state.floatingPnl.toString(),
        marginLevel: state.marginLevel?.toString() ?? null,
        openPositions: valuation.openPositionCount,
        rateToDesk: state.currency === currency ? null : (rate?.toString() ?? null),
        equityInDeskCurrency:
          rate === null ? null : convert(state.equity, currency, rate).toString(),
      });
    }

    if (unpriced.length > 0) {
      this.logger.warn(
        { masterAccountId, currency, unpriced },
        'A desk holds accounts that could not be priced into its currency; totals are withheld',
      );
    }

    return {
      masterAccountId,
      name: master.name,
      currency,
      accounts,
      exposure: [...exposure.entries()]
        .map(([symbol, row]) => ({
          symbol,
          netVolume: row.net.toString(),
          grossNotional: row.gross?.toString() ?? null,
          accounts: row.accounts.size,
        }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      totals: {
        accounts: accounts.length,
        balance: balance?.toString() ?? null,
        equity: equity?.toString() ?? null,
        usedMargin: usedMargin?.toString() ?? null,
        floatingPnl: floating?.toString() ?? null,
        openPositions,
        grossNotional: grossNotional?.toString() ?? null,
      },
      unpriced,
    };
  }

  /**
   * The currency a desk's totals are expressed in.
   *
   * The operator's own account first — a person running a desk thinks in the
   * currency they are paid in — then the first delegated account's, then USD.
   * Whichever it is, it is reported on the view, because a number without its
   * currency is not a number.
   */
  private async deskCurrency(operatorUserId: string, fallback?: string): Promise<string> {
    const own = await this.prisma.account.findFirst({
      where: { userId: operatorUserId },
      orderBy: { createdAt: 'asc' },
      select: { currency: true },
    });
    return own?.currency ?? fallback ?? 'USD';
  }

  /** `null` when no rate can be had — never 1, which would be a silent lie. */
  private async rateTo(from: string, to: string): Promise<Decimal | null> {
    if (from === to) return new Decimal(1);
    try {
      return await this.conversion.rate(from, to);
    } catch (error) {
      this.logger.warn({ err: error, from, to }, 'No rate to price a desk account');
      return null;
    }
  }
}

function convert(amount: Money, currency: string, rate: Decimal): Money {
  return Money.of(new Decimal(amount.amount.toString()).mul(rate).toString(), currency);
}

function emptyView(masterAccountId: string, name: string, currency: string): DeskView {
  return {
    masterAccountId,
    name,
    currency,
    accounts: [],
    exposure: [],
    totals: {
      accounts: 0,
      balance: Money.zero(currency).toString(),
      equity: Money.zero(currency).toString(),
      usedMargin: Money.zero(currency).toString(),
      floatingPnl: Money.zero(currency).toString(),
      openPositions: 0,
      grossNotional: '0',
    },
    unpriced: [],
  };
}
