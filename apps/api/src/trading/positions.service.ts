import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  commissionForLeg,
  exitPriceFor,
  grossPnl,
  Money,
  normalizePrice,
  normalizeVolume,
  toDecimal,
  type Decimal,
} from '@tp/financial-core';
import { validateProtectiveLevels } from '@tp/trading-core';
import {
  CloseReason,
  DomainError,
  DomainEvent,
  Permission,
  TradingErrorCode,
  type OrderSide,
  accountStatusPolicy,
} from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';
import { AccountAccessService } from '../accounts/account-access.service';
import { KillSwitchService } from '../operations/kill-switch.service';
import { LedgerService } from '../accounts/ledger.service';
import { AuditService } from '../common/audit/audit.service';
import { EventsService } from '../realtime/events.service';
import { TradingThrottle } from './trading-throttle.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import type {
  CloseAllResult,
  CloseResult,
  ModifyPositionRequest,
  OrderResult,
} from './trading.types';
import { requireTenantId } from '@tp/tenancy';

interface LoadedPosition {
  id: string;
  accountId: string;
  ownerUserId: string;
  accountCurrency: string;
  /** The account's status at load, which decides what its holder may do. */
  accountStatus: string;
  symbolCode: string;
  symbolId: string;
  side: OrderSide;
  status: string;
  volume: string;
  /** Volume the position opened with. Entry costs were charged against this. */
  initialVolume: string;
  entryPrice: string;
  margin: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  stopLoss: string | null;
  takeProfit: string | null;
  trailingStopDistance: string | null;
  highWaterPrice: string | null;
  version: number;
  openedAt: Date;
}

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountAccessService,
    private readonly killSwitch: KillSwitchService,
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
    private readonly conversion: ConversionService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly events: EventsService,
    private readonly accountState: AccountStateService,
    private readonly throttle: TradingThrottle,
  ) {}

  /**
   * Closes every open position on an account.
   *
   * ## Why this is a server command and not a loop in the browser
   *
   * "Close all" was a loop in the client, one request per position, tolerating
   * partial failure silently. Three things are wrong with that. A trader who
   * pressed it during a fast market got some positions closed and some not,
   * with no record of what they had asked for. A dropped connection halfway
   * through left the rest open while the screen said the button had been
   * pressed. And the platform had no idea the request had ever been made — the
   * audit trail showed a burst of unrelated closes.
   *
   * So the intent is stated once, here, and the outcome is reported per
   * position: what closed, what did not, and why.
   *
   * ## It is not one transaction, and must not be
   *
   * Each close takes its own lock, its own quote and its own ledger entry.
   * Wrapping them in one transaction would hold a lock on every account row
   * for the duration and deadlock against the tick loop closing a stop on the
   * same position — and, worse, would mean one unpriceable instrument rolled
   * back closes that had already happened at real prices.
   *
   * So this is deliberately **not atomic**, and says so in its result rather
   * than pretending. A close that fails is reported with its reason, the
   * others stand, and the trader sees exactly where they are.
   *
   * ## Ordering
   *
   * Largest margin first. If the account is close to a stop-out, closing the
   * heaviest position first releases the most margin soonest, which makes it
   * more likely the rest can be closed at all rather than being liquidated
   * mid-way through by the engine.
   */
  async closeAll(
    userId: string,
    accountId: string,
    reason: CloseReason = CloseReason.MANUAL,
  ): Promise<CloseAllResult> {
    // The same access check every single close makes, made once up front so a
    // caller with no right to the account is refused before anything moves.
    await this.access.resolve(userId, accountId, Permission.POSITIONS_CLOSE);

    const open = await this.prisma.position.findMany({
      where: { accountId, status: 'OPEN' },
      orderBy: [{ margin: 'desc' }, { openedAt: 'asc' }],
      select: { id: true },
    });

    const closed: CloseResult[] = [];
    const refused: { positionId: string; code: string; message: string }[] = [];

    for (const position of open) {
      try {
        closed.push(await this.close(userId, position.id, null, reason));
      } catch (error) {
        /**
         * Kept, not thrown. One position that cannot be closed — a stale
         * quote, a market that shut a second ago, a stop that got there first
         * — must not stop the others, and must not be silent either.
         */
        const domain = error instanceof DomainError ? error : null;
        refused.push({
          positionId: position.id,
          code: domain?.code ?? TradingErrorCode.INTERNAL_ERROR,
          message: domain?.message ?? 'This position could not be closed.',
        });
      }
    }

    if (refused.length > 0) {
      this.logger.warn(
        { accountId, userId, closed: closed.length, refused },
        'A close-all left positions open',
      );
    }
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'POSITION_CLOSE_ALL',
      resourceType: 'Account',
      resourceId: accountId,
      after: {
        asked: open.length,
        closed: closed.length,
        refused: refused.map((one) => `${one.positionId}: ${one.code}`),
      },
    });

    return { asked: open.length, closed, refused };
  }

  /**
   * Closes a position, in whole or in part.
   *
   * The first thing this does is move the position `OPEN -> CLOSING` with a
   * conditional update. Whoever wins that update owns the close; a second
   * request, a stop-loss trigger and a liquidation all lose it and stop. The
   * guard is a database write, not an in-process flag, so it holds across
   * multiple API instances.
   *
   * If anything after the guard fails — most likely a stale quote — the
   * position is put back to OPEN. A position stranded in CLOSING would be
   * untradeable and invisible to the stop-out check.
   */
  async close(
    userId: string,
    positionId: string,
    requestedVolume: string | null,
    reason: CloseReason = CloseReason.MANUAL,
  ): Promise<CloseResult> {
    const position = await this.loadOwned(userId, positionId, Permission.POSITIONS_CLOSE);
    return this.performClose(position, requestedVolume, reason, userId);
  }

  /**
   * Closes a position on the platform's own initiative — a stop-loss firing, a
   * take-profit, a liquidation.
   *
   * Skips the ownership check because there is no user making the request, and
   * audits the action as SYSTEM. Everything after that is the same code path as
   * a manual close, including the OPEN -> CLOSING guard, so an engine close and
   * a trader's close cannot both settle the same position.
   */
  async closeForSystem(
    positionId: string,
    requestedVolume: string | null,
    reason: CloseReason,
  ): Promise<CloseResult> {
    const position = await this.load(positionId);
    return this.performClose(position, requestedVolume, reason, null);
  }

  private async performClose(
    position: LoadedPosition,
    requestedVolume: string | null,
    reason: CloseReason,
    actorUserId: string | null,
  ): Promise<CloseResult> {
    const positionId = position.id;
    /**
     * A person closing is bound by the account's status; the engine is not.
     * A stop-loss or a liquidation on a locked account must still fire —
     * the lock is on the holder, not on the risk.
     */
    if (actorUserId !== null && !accountStatusPolicy(position.accountStatus).close) {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        `This account is ${position.accountStatus.toLowerCase()} and its positions cannot be closed by its holder`,
        { status: position.accountStatus, positionId },
      );
    }
    // The engine's closes are not throttled: a stop that fires is not a request.
    if (actorUserId !== null) await this.throttle.assertAllowed(position.accountId);
    if (position.status !== 'OPEN') {
      throw new DomainError(
        TradingErrorCode.POSITION_ALREADY_CLOSING,
        `Position is ${position.status.toLowerCase()} and cannot be closed again`,
        { positionId, status: position.status },
      );
    }

    const spec = this.symbols.requireSpec(position.symbolCode);
    const openVolume = toDecimal(position.volume);
    const closeVolume =
      requestedVolume == null ? openVolume : normalizeVolume(spec, requestedVolume);

    if (closeVolume.lte(0)) {
      throw new DomainError(TradingErrorCode.INVALID_VOLUME, 'Close volume must be positive');
    }
    if (closeVolume.gt(openVolume)) {
      throw new DomainError(
        TradingErrorCode.PARTIAL_CLOSE_EXCEEDS_VOLUME,
        `Cannot close ${closeVolume.toString()} lots of a ${openVolume.toString()} lot position`,
        { requested: closeVolume.toString(), open: openVolume.toString() },
      );
    }
    const remaining = openVolume.minus(closeVolume);
    // A remainder below the minimum tradeable size could never be closed
    // afterwards, so the whole position goes instead.
    const fullyClosed = remaining.lt(toDecimal(spec.minVolume));
    const effectiveCloseVolume = fullyClosed ? openVolume : closeVolume;
    const effectiveRemaining = fullyClosed ? toDecimal(0) : remaining;

    const claimed = await this.prisma.position.updateMany({
      where: { id: positionId, status: 'OPEN', version: position.version },
      data: { status: 'CLOSING', version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new DomainError(
        TradingErrorCode.POSITION_ALREADY_CLOSING,
        'Another request is already closing this position',
        { positionId },
      );
    }

    try {
      const tick = await this.quotes.requireFresh(position.symbolCode);
      const exitPrice = normalizePrice(spec, exitPriceFor(position.side, tick));
      const rate = await this.conversion.rate(spec.quoteCurrency, position.accountCurrency);

      /**
       * Every component is rounded here, once, and every later use is of the
       * rounded value — the trade row, the ledger posting and `net` alike.
       *
       * Rounding at the point of *use* instead looks identical and is not: the
       * ledger would move by `round(gross) − round(exitCommission) + round(swap)`
       * while the trade row recorded `round(gross − commission + swap)`, and
       * those differ by a cent whenever a component lands off one. A trade
       * report that disagrees with the ledger by a cent is a dispute nobody can
       * settle, and realized P&L on the terminal is summed from these rows.
       */
      const gross = grossPnl({
        spec,
        side: position.side,
        volume: effectiveCloseVolume,
        entryPrice: position.entryPrice,
        exitPrice,
        accountCurrency: position.accountCurrency,
        quoteToAccountRate: rate,
      }).round();
      const exitCommission = commissionForLeg(
        spec,
        effectiveCloseVolume,
        position.accountCurrency,
        rate,
      ).round();
      // Accrued swap is released in proportion to the volume still open, because
      // that is the volume it accrued on.
      const closedFraction = effectiveCloseVolume.div(openVolume);
      const swap = Money.of(position.swap, position.accountCurrency).times(closedFraction).round();

      // The entry commission is apportioned against the volume the position
      // *opened* with, not the volume still open. It was charged once, on the
      // whole position; splitting it by the remaining volume would charge more
      // than was ever taken as the position is closed piece by piece.
      const entryCommission = await this.apportionEntryCommission(position, {
        closeVolume: effectiveCloseVolume,
        fullyClosed,
      });
      const commission = entryCommission.plus(exitCommission);

      // Net is the round trip: what the trader actually kept. It reconciles
      // with the balance over the position's whole life — the entry
      // commission charged when it opened, the swap settled each night it was
      // held, and what this close moves — and not with this close alone.
      // Every term is already at cent precision, so this sum needs no rounding
      // of its own — and must not get one.
      const net = gross.minus(commission).plus(swap);
      const marginReleased = Money.of(position.margin, position.accountCurrency).times(
        closedFraction,
      );

      const result = await this.prisma.$transaction(async (tx) => {
        // The account's write lock first: the closing order and its execution
        // both take a share lock on this row, and the ledger post wants it
        // exclusively. See LedgerService.lockAccount.
        await this.ledger.lockAccount(tx, position.accountId);

        const closingOrder = await tx.order.create({
          data: {
            tenantId: requireTenantId(),
            accountId: position.accountId,
            symbolId: position.symbolId,
            side: position.side === 'BUY' ? 'SELL' : 'BUY',
            type: 'MARKET',
            status: 'FILLED',
            timeInForce: 'IOC',
            volume: effectiveCloseVolume.toString(),
            filledVolume: effectiveCloseVolume.toString(),
            positionId: position.id,
          },
        });
        await tx.orderEvent.createMany({
          data: [
            {
              tenantId: requireTenantId(),
              orderId: closingOrder.id,
              type: 'CREATED',
              toStatus: 'NEW',
            },
            {
              tenantId: requireTenantId(),
              orderId: closingOrder.id,
              type: 'ACCEPTED',
              fromStatus: 'NEW',
              toStatus: 'ACCEPTED',
            },
            {
              tenantId: requireTenantId(),
              orderId: closingOrder.id,
              type: 'FILLED',
              fromStatus: 'ACCEPTED',
              toStatus: 'FILLED',
              payload: { price: exitPrice.toString(), reason },
            },
          ],
        });
        await tx.execution.create({
          data: {
            tenantId: requireTenantId(),
            orderId: closingOrder.id,
            accountId: position.accountId,
            side: position.side === 'BUY' ? 'SELL' : 'BUY',
            volume: effectiveCloseVolume.toString(),
            price: exitPrice.toString(),
            quoteBid: tick.bid,
            quoteAsk: tick.ask,
            quoteAt: new Date(tick.timestamp),
          },
        });

        await tx.trade.create({
          data: {
            tenantId: requireTenantId(),
            accountId: position.accountId,
            positionId: position.id,
            symbolId: position.symbolId,
            side: position.side,
            volume: effectiveCloseVolume.toString(),
            entryPrice: position.entryPrice,
            exitPrice: exitPrice.toString(),
            entryTime: position.openedAt,
            exitTime: new Date(),
            grossPnl: gross.round().toString(),
            entryCommission: entryCommission.round().toString(),
            exitCommission: exitCommission.round().toString(),
            commission: commission.round().toString(),
            swap: swap.round().toString(),
            netPnl: net.round().toString(),
            closeReason: reason,
          },
        });

        // Price result and costs are separate ledger entries. Netting them into
        // one line would make a statement unreadable and a commission dispute
        // unanswerable.
        /**
         * Posted whether or not it moved anything.
         *
         * A round trip whose result rounds to zero — a 0.01-lot scalp inside
         * the spread — is still a trade, and "every trade has a ledger entry"
         * is one of the reconciliation checks this platform owes itself. Making
         * it "every trade except the break-even ones" turns a rule into a rule
         * with an exception, and the exception is where a genuinely missing
         * entry would hide.
         *
         * A `0.00` line on a statement is honest: the trade produced no gain.
         * An absent line is not.
         */
        {
          await this.ledger.post(tx, {
            accountId: position.accountId,
            type: gross.isPositive() ? 'TRADE_PROFIT' : 'TRADE_LOSS',
            amount: gross,
            referenceType: 'Position',
            referenceId: position.id,
            description: `${position.symbolCode} ${position.side} ${effectiveCloseVolume.toString()} lots`,
          });
        }
        // Only the closing leg moves money here. The opening leg was posted when
        // the position was opened; posting it again would charge it twice.
        if (exitCommission.isPositive()) {
          await this.ledger.post(tx, {
            accountId: position.accountId,
            type: 'COMMISSION',
            amount: exitCommission.negated(),
            referenceType: 'Position',
            referenceId: position.id,
            description: `Commission on closing ${position.symbolCode}`,
          });
        }
        /**
         * Swap is **not** posted here, and the absence is the point.
         *
         * Overnight financing is settled into the balance on the night it
         * accrues — `swap-accrual.service.ts` in the worker writes the ledger
         * entry, moves the balance and adds the amount to `position.swap` in
         * one transaction. So `position.swap` is the record of what has
         * *already been charged*, and its share is carried onto the trade row
         * so the trade's net is the whole round trip. Posting it to the ledger
         * again at close charged — or credited — every overnight position
         * twice. Reconciliation found it the first hour it ran: the ledger
         * held exactly double the swap the trades reported, and the realized
         * total was out by the same amount.
         */

        const remainingMargin = Money.of(position.margin, position.accountCurrency).minus(
          marginReleased,
        );
        await tx.position.update({
          where: { id: position.id },
          data: fullyClosed
            ? {
                status: 'CLOSED',
                volume: '0',
                margin: '0',
                currentPrice: exitPrice.toString(),
                realizedPnl: Money.of(position.realizedPnl, position.accountCurrency)
                  .plus(net)
                  .toString(),
                closeReason: reason,
                closedAt: new Date(),
                version: { increment: 1 },
              }
            : {
                status: 'OPEN',
                volume: effectiveRemaining.toString(),
                margin: remainingMargin.toString(),
                swap: Money.of(position.swap, position.accountCurrency).minus(swap).toString(),
                currentPrice: exitPrice.toString(),
                realizedPnl: Money.of(position.realizedPnl, position.accountCurrency)
                  .plus(net)
                  .toString(),
                version: { increment: 1 },
              },
        });

        await tx.positionEvent.create({
          data: {
            tenantId: requireTenantId(),
            positionId: position.id,
            type: fullyClosed ? 'CLOSED' : 'PARTIALLY_CLOSED',
            fromStatus: 'CLOSING',
            toStatus: fullyClosed ? 'CLOSED' : 'OPEN',
            payload: {
              exitPrice: exitPrice.toString(),
              volume: effectiveCloseVolume.toString(),
              grossPnl: gross.round().toString(),
              netPnl: net.round().toString(),
              reason,
            },
          },
        });

        const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
        return {
          balanceAfter: Money.of(account.balance.toString(), position.accountCurrency).toString(),
        };
      });

      await this.audit.record({
        actorId: actorUserId,
        actorType: actorUserId === null ? 'SYSTEM' : 'USER',
        action: 'POSITION_CLOSE',
        resourceType: 'Position',
        resourceId: position.id,
        after: {
          volume: effectiveCloseVolume.toString(),
          exitPrice: exitPrice.toString(),
          netPnl: net.round().toString(),
          reason,
        },
      });

      await this.events.publish(DomainEvent.POSITION_CLOSED, position.accountId, {
        positionId: position.id,
        symbol: position.symbolCode,
        closedVolume: effectiveCloseVolume.toString(),
        remainingVolume: effectiveRemaining.toString(),
        exitPrice: exitPrice.toString(),
        netPnl: net.round().toString(),
        reason,
        fullyClosed,
      });
      await this.events.publish(DomainEvent.BALANCE_CHANGED, position.accountId, {
        balance: result.balanceAfter,
        cause: 'POSITION_CLOSE',
      });

      return {
        positionId: position.id,
        closedVolume: effectiveCloseVolume.toString(),
        remainingVolume: effectiveRemaining.toString(),
        exitPrice: exitPrice.toString(),
        grossPnl: gross.round().toString(),
        entryCommission: entryCommission.round().toString(),
        exitCommission: exitCommission.round().toString(),
        commission: commission.round().toString(),
        swap: swap.round().toString(),
        netPnl: net.round().toString(),
        balanceAfter: result.balanceAfter,
        closeReason: reason,
        fullyClosed,
      };
    } catch (error) {
      // Put the position back so it stays tradeable and visible to risk.
      await this.prisma.position
        .updateMany({
          where: { id: positionId, status: 'CLOSING' },
          data: { status: 'OPEN', version: { increment: 1 } },
        })
        .catch((releaseError: unknown) => {
          this.logger.error(
            { err: releaseError, positionId },
            'Failed to release a position from CLOSING; it needs manual attention',
          );
        });
      throw error;
    }
  }

  /**
   * Changes stop-loss and take-profit.
   *
   * Levels are validated against the current *executable exit* price, not the
   * entry price: a stop that is already through the market would fire on the
   * next tick, closing a position the trader was trying to protect.
   */
  /**
   * Protective levels stay modifiable during a halt, deliberately.
   *
   * The specification leaves this to policy, and the policy here follows from
   * what a halt is for. A trader living through a market event most wants to
   * *tighten* a stop, and refusing that would trap them in risk they were trying
   * to reduce. The same door lets somebody widen one — which is a decision about
   * their own position that they could equally make by closing and reopening
   * once trading resumes.
   */
  async modify(userId: string, request: ModifyPositionRequest): Promise<Record<string, unknown>> {
    const position = await this.loadOwned(userId, request.positionId, Permission.POSITIONS_MODIFY);
    if (!accountStatusPolicy(position.accountStatus).modify) {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        `This account is ${position.accountStatus.toLowerCase()} and its positions cannot be modified`,
        { status: position.accountStatus, positionId: position.id },
      );
    }
    await this.throttle.assertAllowed(position.accountId);
    if (position.status !== 'OPEN') {
      throw new DomainError(
        TradingErrorCode.POSITION_ALREADY_CLOSING,
        'A position that is closing cannot be modified',
        { positionId: position.id },
      );
    }

    const spec = this.symbols.requireSpec(position.symbolCode);
    const tick = await this.quotes.requireFresh(position.symbolCode);
    const reference = normalizePrice(spec, exitPriceFor(position.side, tick));

    const stopLoss = request.stopLoss === undefined ? position.stopLoss : request.stopLoss;
    const takeProfit = request.takeProfit === undefined ? position.takeProfit : request.takeProfit;
    const trailing =
      request.trailingStopDistance === undefined
        ? position.trailingStopDistance
        : request.trailingStopDistance;
    validateProtectiveLevels(spec, position.side, reference.toString(), { stopLoss, takeProfit });

    const updated = await this.prisma.position.updateMany({
      where: { id: position.id, status: 'OPEN', version: position.version },
      data: {
        stopLoss,
        takeProfit,
        trailingStopDistance: trailing,
        // The ratchet anchors on the current executable price when trailing is
        // switched on, and the anchor is dropped when it is switched off, so a
        // later re-enable does not inherit a high-water mark from last week.
        highWaterPrice:
          trailing === null ? null : (position.highWaterPrice ?? reference.toString()),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw new DomainError(
        TradingErrorCode.CONCURRENT_MODIFICATION,
        'The position changed while this modification was being prepared. Retry against the current state.',
        { positionId: position.id },
      );
    }

    await this.prisma.positionEvent.create({
      data: {
        tenantId: requireTenantId(),
        positionId: position.id,
        type: 'MODIFIED',
        fromStatus: 'OPEN',
        toStatus: 'OPEN',
        payload: {
          stopLoss: stopLoss ?? null,
          takeProfit: takeProfit ?? null,
          trailingStopDistance: trailing ?? null,
          previousStopLoss: position.stopLoss,
          previousTakeProfit: position.takeProfit,
        },
      },
    });

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'POSITION_MODIFY',
      resourceType: 'Position',
      resourceId: position.id,
      before: { stopLoss: position.stopLoss, takeProfit: position.takeProfit },
      after: { stopLoss: stopLoss ?? null, takeProfit: takeProfit ?? null },
    });

    await this.events.publish(DomainEvent.POSITION_MODIFIED, position.accountId, {
      positionId: position.id,
      symbol: position.symbolCode,
      stopLoss: stopLoss ?? null,
      takeProfit: takeProfit ?? null,
      trailingStopDistance: trailing ?? null,
    });

    return { positionId: position.id, stopLoss, takeProfit, trailingStopDistance: trailing };
  }

  /**
   * Reverses a position: close it, then open the same size the other way.
   *
   * These are two operations, not one, and that is a deliberate choice rather
   * than an oversight. If the close succeeds and the reopen is rejected — no
   * margin, market closed, risk limit — the trader ends up flat. Flat is the
   * safe failure: it is the state they explicitly asked to leave, and it can be
   * corrected with one more order. Making it atomic would mean holding the
   * close hostage to whether the new position is permitted.
   */
  async reverse(
    userId: string,
    positionId: string,
  ): Promise<{ closed: CloseResult; opened: OrderResult }> {
    /**
     * Refused up front during a halt, not halfway through.
     *
     * Reverse is a close and then an open. Letting it start would close the
     * position, hit the halt on the open, and leave the trader flat when they
     * asked to be the other way round — a worse outcome than being told no. They
     * can still close, which is the half a halt permits.
     */
    this.killSwitch.assertMayOpenRisk();

    // Reverse is a close and an open, so it needs the capability for both.
    const position = await this.loadOwned(userId, positionId, Permission.POSITIONS_CLOSE);
    const volume = position.volume;
    const closed = await this.close(userId, positionId, null, CloseReason.REVERSE);
    const opened = await this.orders.openPosition(userId, {
      accountId: position.accountId,
      symbol: position.symbolCode,
      side: position.side === 'BUY' ? 'SELL' : 'BUY',
      volume,
    });
    return { closed, opened };
  }

  /**
   * A trader's positions, each marked to market.
   *
   * ## Why the floating P&L is here and not left to the caller
   *
   * A positions list without it is not a positions list — it is a list of
   * things that were once bought, with no indication of whether holding them
   * was a good idea. Every client needs the number, and the only alternative to
   * serving it is each client computing it from `entryPrice`, `currentPrice`
   * and the contract size: money arithmetic in floating point, reimplemented on
   * web, Android and iOS, drifting from `AccountStateService` and from each
   * other. The web terminal happens to get it from the WebSocket; a phone
   * opening the app cold has no socket frame yet.
   *
   * `valuate()` is the single place this is computed, and it is already the
   * source for the risk engine, the account screen and the stop-out check. This
   * reads from it rather than adding a second calculation.
   */
  async list(userId: string, accountId: string, includeClosed: boolean, limit: number) {
    await this.access.resolve(userId, accountId, Permission.POSITIONS_READ);
    const positions = await this.prisma.position.findMany({
      where: {
        accountId,
        ...(includeClosed ? {} : { status: { in: ['OPEN', 'CLOSING'] } }),
      },
      include: { symbol: true },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });

    /**
     * Valued once for the whole list, not once per row.
     *
     * A closed position has no floating P&L by definition, so when the caller
     * asked only for closed ones there is nothing to value and the extra query
     * is skipped.
     */
    const valuations = positions.some(
      (position) => position.status === 'OPEN' || position.status === 'CLOSING',
    )
      ? new Map(
          (await this.accountState.valuate(accountId)).positions.map((valuation) => [
            valuation.positionId,
            valuation,
          ]),
        )
      : new Map();

    return positions.map((position) => ({
      id: position.id,
      symbol: position.symbol.code,
      side: position.side,
      status: position.status,
      volume: position.volume.toString(),
      initialVolume: position.initialVolume.toString(),
      entryPrice: position.entryPrice.toString(),
      currentPrice: position.currentPrice?.toString() ?? null,
      stopLoss: position.stopLoss?.toString() ?? null,
      takeProfit: position.takeProfit?.toString() ?? null,
      trailingStopDistance: position.trailingStopDistance?.toString() ?? null,
      highWaterPrice: position.highWaterPrice?.toString() ?? null,
      margin: position.margin.toString(),
      commission: position.commission.toString(),
      swap: position.swap.toString(),
      realizedPnl: position.realizedPnl.toString(),
      /**
       * Price P&L at the current mark, before costs. `null` for a closed
       * position, and for an open one whose instrument has no fresh quote —
       * never `'0'`, because a trader cannot tell a genuine flat from a missing
       * price, and one of those is a reason to act.
       */
      floatingPnl: valuations.get(position.id)?.floatingPnl?.toString() ?? null,
      /** True when no fresh price existed, so the mark above is not current. */
      stale: valuations.get(position.id)?.stale ?? null,
      /**
       * Floating P&L less the costs already charged against this position.
       *
       * Deliberately not an estimate of the round trip — the exit commission
       * has not been charged, and inventing it would put a number on screen no
       * ledger entry will ever match.
       */
      netFloatingPnl: valuations.get(position.id)?.netPnl?.toString() ?? null,
      closeReason: position.closeReason,
      openedAt: position.openedAt.toISOString(),
      closedAt: position.closedAt?.toISOString() ?? null,
    }));
  }

  async trades(userId: string, accountId: string, limit: number) {
    await this.access.resolve(userId, accountId, Permission.POSITIONS_READ);
    const trades = await this.prisma.trade.findMany({
      where: { accountId },
      include: { symbol: true },
      orderBy: { exitTime: 'desc' },
      take: limit,
    });
    return trades.map((trade) => ({
      id: trade.id,
      symbol: trade.symbol.code,
      side: trade.side,
      volume: trade.volume.toString(),
      entryPrice: trade.entryPrice.toString(),
      exitPrice: trade.exitPrice.toString(),
      entryTime: trade.entryTime.toISOString(),
      exitTime: trade.exitTime.toISOString(),
      grossPnl: trade.grossPnl.toString(),
      entryCommission: trade.entryCommission.toString(),
      exitCommission: trade.exitCommission.toString(),
      commission: trade.commission.toString(),
      swap: trade.swap.toString(),
      netPnl: trade.netPnl.toString(),
      closeReason: trade.closeReason,
    }));
  }

  /**
   * This close's share of the commission charged when the position opened.
   *
   * Two rules, and the second exists because of the first.
   *
   * The share is against the volume the position *opened* with, never the
   * volume still open: the commission was charged once, on the whole position,
   * and dividing by what remains charges more than was ever taken as the
   * position is closed piece by piece.
   *
   * And the **last** close takes whatever is left rather than its own
   * proportion. Three closes of a third each, of a commission of 0.05, round to
   * 0.02 apiece and sum to 0.06 — a cent that was never charged, appearing in a
   * report as though it had been. Giving the final close the remainder makes the
   * shares sum to the charge exactly, whatever the arithmetic in between.
   */
  private async apportionEntryCommission(
    position: LoadedPosition,
    close: { closeVolume: Decimal; fullyClosed: boolean },
  ): Promise<Money> {
    const charged = Money.of(position.commission, position.accountCurrency);

    if (close.fullyClosed) {
      const priorTrades = await this.prisma.trade.aggregate({
        where: { positionId: position.id },
        _sum: { entryCommission: true },
      });
      const alreadyApportioned = Money.of(
        priorTrades._sum.entryCommission?.toString() ?? '0',
        position.accountCurrency,
      );
      return charged.minus(alreadyApportioned);
    }

    const fraction = close.closeVolume.div(toDecimal(position.initialVolume));
    return charged.times(fraction).round();
  }

  /**
   * Loads a position the caller may act on.
   *
   * The account is resolved through `AccountAccessService` rather than by
   * comparing `position.ownerUserId` here, so that whatever reaches an account
   * — ownership today, a master link tomorrow — reaches its positions by the
   * same decision. A second copy of the rule is a second thing to keep in step.
   *
   * A refusal reads as "position not found", not "account not found": the
   * caller asked about a position and must not learn that the id is real but
   * belongs to someone else.
   */
  private async loadOwned(
    userId: string,
    positionId: string,
    needs: Permission,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<LoadedPosition> {
    const position = await this.load(positionId, client);
    try {
      await this.access.resolve(userId, position.accountId, needs, client);
    } catch {
      throw new DomainError(TradingErrorCode.POSITION_NOT_FOUND, 'Position not found', {
        positionId,
      });
    }
    return position;
  }

  private async load(
    positionId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<LoadedPosition> {
    const position = await client.position.findUnique({
      where: { id: positionId },
      include: { account: true, symbol: true },
    });
    if (position === null) {
      throw new DomainError(TradingErrorCode.POSITION_NOT_FOUND, 'Position not found', {
        positionId,
      });
    }
    return {
      id: position.id,
      accountId: position.accountId,
      ownerUserId: position.account.userId,
      accountCurrency: position.account.currency,
      accountStatus: position.account.status,
      symbolCode: position.symbol.code,
      symbolId: position.symbolId,
      side: position.side,
      status: position.status,
      volume: position.volume.toString(),
      initialVolume: position.initialVolume.toString(),
      entryPrice: position.entryPrice.toString(),
      margin: position.margin.toString(),
      commission: position.commission.toString(),
      swap: position.swap.toString(),
      realizedPnl: position.realizedPnl.toString(),
      stopLoss: position.stopLoss?.toString() ?? null,
      takeProfit: position.takeProfit?.toString() ?? null,
      trailingStopDistance: position.trailingStopDistance?.toString() ?? null,
      highWaterPrice: position.highWaterPrice?.toString() ?? null,
      version: position.version,
      openedAt: position.openedAt,
    };
  }
}
