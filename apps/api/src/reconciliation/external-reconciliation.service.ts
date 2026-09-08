import { Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { toDecimal } from '@tp/financial-core';
import {
  compareBalance,
  compareExecutions,
  compareFeeTotals,
  compareOrders,
  comparePositions,
  ItemStatus,
  tally,
  type ReconciliationItem,
  type Tolerances,
} from '@tp/reconciliation-core';
import type { BrokerAdapter } from '@tp/broker-sdk';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { BrokerConnectionsService } from '../broker-connections/broker-connections.service';
import { AccountStateService } from '../trading/account-state.service';
import { AuditService } from '../common/audit/audit.service';

export interface ExternalRunSummary {
  readonly runId: string;
  readonly connectionId: string;
  readonly accountsChecked: number;
  readonly compared: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly missing: number;
  readonly unknown: number;
  /** Accounts the venue could not be asked about. Never counted as clean. */
  readonly unreachable: number;
}

/** How far back executions are compared when nothing narrower is asked for. */
const DEFAULT_EXECUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The platform's records against a venue's (§44).
 *
 * ## The rule this component exists to obey
 *
 * **An unreachable venue is not evidence of anything.** If `getOrders` times
 * out, the platform has not discovered that its orders are missing — it has
 * discovered that it cannot see the venue's. Writing `MISSING_EXTERNAL` for
 * every order in that case would produce a reconciliation report saying the
 * firm's entire book is unbacked, on the day the network was bad. So a failure
 * to reach the venue for an account **aborts that account's comparison** and is
 * counted as unreachable; it never becomes an item.
 *
 * This is the same principle as §26's "never interpret an API timeout as a
 * trader breaching rules", applied to the other end of the system, and it is
 * the single property most worth protecting here.
 *
 * ## Nothing is repaired
 *
 * §112. A discrepancy is recorded and shown; correcting it is a deliberate,
 * separate, audited act by a person, recorded as a `ResolutionRecord`.
 * Auto-correcting would erase the evidence of how the drift happened — the one
 * thing an investigation needs — and would turn a bug that shows up once into
 * one that quietly cleans up after itself for ever.
 *
 * ## Only disagreements are stored
 *
 * A matched order is a row the platform would write on every run for the life
 * of the account. The counts on the run say what those rows would have said.
 */
@Injectable()
export class ExternalReconciliationService {
  private readonly logger = new Logger(ExternalReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: BrokerConnectionsService,
    private readonly accountState: AccountStateService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Compare every externally-executed account on one connection.
   *
   * Runs inside the caller's tenant — the connection, its accounts and the run
   * row all belong to one firm, and there is no cross-tenant reconciliation to
   * do: two firms pointed at one venue still each own only their own accounts.
   */
  async run(options: {
    readonly connectionId: string;
    readonly trigger: 'SCHEDULED' | 'MANUAL';
    readonly requestedByUserId?: string | null;
    readonly tolerances?: Tolerances;
    readonly since?: Date;
  }): Promise<ExternalRunSummary> {
    const tenantId = requireTenantId();
    const startedAt = Date.now();

    const accounts = await this.prisma.account.findMany({
      where: {
        brokerConnectionId: options.connectionId,
        executionMode: 'EXTERNAL_BROKER',
        externalAccountId: { not: null },
      },
      select: {
        id: true,
        number: true,
        currency: true,
        balance: true,
        externalAccountId: true,
      },
    });

    /**
     * The run row is written *before* the work starts and closed when it ends,
     * including when it fails. "The last run was clean" and "there has been no
     * run since Tuesday" look identical if only items are stored, and only one
     * of them is reassuring.
     */
    const run = await this.prisma.reconciliationRun.create({
      data: {
        tenantId,
        kind: 'EXTERNAL',
        brokerConnectionId: options.connectionId,
        trigger: options.trigger,
        requestedByUserId: options.requestedByUserId ?? null,
        accountsChecked: 0,
      },
      select: { id: true },
    });

    let compared = 0;
    let unreachable = 0;
    let checked = 0;
    const items: Array<ReconciliationItem & { accountId: string }> = [];

    try {
      for (const account of accounts) {
        const externalAccountId = account.externalAccountId;
        if (externalAccountId === null) continue;

        let observed: readonly ReconciliationItem[];
        try {
          observed = await this.compareAccount({
            connectionId: options.connectionId,
            externalAccountId,
            accountId: account.id,
            accountNumber: account.number,
            currency: account.currency,
            since: options.since ?? new Date(Date.now() - DEFAULT_EXECUTION_WINDOW_MS),
            tolerances: options.tolerances,
          });
        } catch (error) {
          /**
           * The venue could not be asked. Nothing is concluded and nothing is
           * written: an item saying the venue has no record of our orders,
           * produced by a timeout, is a false accusation against our own books.
           */
          unreachable += 1;
          this.logger.error(
            { err: error, accountId: account.id, connectionId: options.connectionId },
            'Could not reach the venue for this account; nothing was concluded',
          );
          continue;
        }

        checked += 1;
        compared += observed.length;
        for (const item of observed) {
          if (item.status === ItemStatus.MATCHED) continue;
          items.push({ ...item, accountId: account.id });
        }
      }

      const counts = tally(items);
      const matched = compared - items.length;
      const missing = counts.MISSING_INTERNAL + counts.MISSING_EXTERNAL;
      const mismatched =
        counts.QUANTITY_MISMATCH +
        counts.PRICE_MISMATCH +
        counts.FEE_MISMATCH +
        counts.BALANCE_MISMATCH;

      if (items.length > 0) {
        await this.prisma.reconciliationItem.createMany({
          data: items.map((item) => ({
            tenantId,
            runId: run.id,
            accountId: item.accountId,
            brokerConnectionId: options.connectionId,
            subject: item.subject,
            key: item.key,
            status: item.status,
            field: item.field,
            internal: item.internal,
            external: item.external,
            difference: item.difference,
            tolerance: item.tolerance,
            message: item.message,
          })),
        });
      }

      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          accountsChecked: checked,
          itemsCompared: compared,
          itemsMatched: matched,
          itemsMismatched: mismatched,
          itemsMissing: missing,
          itemsUnknown: counts.UNKNOWN,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      });

      await this.audit.record({
        actorType: options.requestedByUserId === undefined ? 'SYSTEM' : 'USER',
        actorId: options.requestedByUserId ?? null,
        action: 'RECONCILIATION_EXTERNAL_RUN',
        resourceType: 'ReconciliationRun',
        resourceId: run.id,
        after: {
          connectionId: options.connectionId,
          accountsChecked: checked,
          unreachable,
          mismatched,
          missing,
          unknown: counts.UNKNOWN,
        },
      });

      return {
        runId: run.id,
        connectionId: options.connectionId,
        accountsChecked: checked,
        compared,
        matched,
        mismatched,
        missing,
        unknown: counts.UNKNOWN,
        unreachable,
      };
    } catch (error) {
      /**
       * The run itself failed — not the comparison. Closed as FAILED so the
       * console can tell "we looked and found nothing" from "we never looked".
       */
      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      });
      throw error;
    }
  }

  /**
   * One account, four comparisons.
   *
   * Every venue call happens inside a single `withAdapter`, so one connection
   * is opened per account rather than four. A throw from any of them leaves
   * this method — deliberately: a partial answer from a venue is not a partial
   * disagreement, it is an unanswered question, and the caller counts it as one.
   */
  private async compareAccount(args: {
    readonly connectionId: string;
    readonly externalAccountId: string;
    readonly accountId: string;
    readonly accountNumber: string;
    readonly currency: string;
    readonly since: Date;
    readonly tolerances?: Tolerances;
  }): Promise<readonly ReconciliationItem[]> {
    const venue = await this.connections.withAdapter(args.connectionId, async (adapter) =>
      this.readVenue(adapter, args.externalAccountId, args.since),
    );

    const valuation = await this.accountState.valuate(args.accountId);

    const [orders, positions, executions] = await Promise.all([
      this.internalOrders(args.accountId),
      this.internalPositions(args.accountId),
      this.internalExecutions(args.accountId, args.since),
    ]);

    return [
      ...compareBalance(
        {
          accountNumber: args.accountNumber,
          currency: args.currency,
          balance: valuation.state.balance.toString(),
          equity: valuation.state.equity.toString(),
        },
        {
          currency: venue.account.currency,
          balance: venue.account.balance,
          equity: venue.account.equity,
        },
        args.tolerances,
      ),
      ...compareOrders(orders, venue.orders, args.tolerances),
      ...comparePositions(positions, venue.positions, args.tolerances),
      ...compareExecutions(executions, venue.executions, args.tolerances),
      ...compareFeeTotals(
        args.accountNumber,
        await this.internalCommission(args.accountId, args.since),
        venue.commissionTotal,
        args.tolerances,
      ),
    ];
  }

  private async readVenue(adapter: BrokerAdapter, externalAccountId: string, since: Date) {
    const [account, positions, orders, executions] = await Promise.all([
      adapter.getAccount(externalAccountId),
      adapter.getPositions(externalAccountId),
      adapter.getOrders(externalAccountId),
      adapter.getExecutions(externalAccountId, since),
    ]);
    return {
      account,
      positions: positions.map((row) => ({
        externalPositionId: row.externalPositionId,
        volume: row.volume,
        entryPrice: row.entryPrice,
      })),
      orders: orders.map((row) => ({
        clientOrderId: row.clientOrderId,
        externalOrderId: row.externalOrderId,
        volume: row.volume,
        filledVolume: row.filledVolume,
        price: row.price,
        status: row.status,
      })),
      executions: executions.map((row) => ({
        externalExecutionId: row.externalExecutionId,
        volume: row.volume,
        price: row.price,
        commission: row.commission,
      })),
      /**
       * Null when the venue quoted commission on none of the fills — which is
       * a venue that does not report it, not a venue that charges nothing.
       * A total of zero derived from silence would raise our whole commission
       * as a mismatch on every run.
       */
      commissionTotal: executions.every((row) => row.commission === null)
        ? null
        : executions
            .reduce((sum, row) => sum.plus(toDecimal(row.commission ?? '0')), toDecimal('0'))
            .toString(),
    };
  }

  /**
   * Commission this platform charged over the window.
   *
   * Read from positions, because that is where this platform books it. The
   * venue books it per fill; there is no honest way to split ours back out into
   * theirs, so the comparison is the total — see `compareFeeTotals`.
   */
  private async internalCommission(accountId: string, since: Date): Promise<string> {
    const rows = await this.prisma.position.findMany({
      where: { accountId, openedAt: { gte: since } },
      select: { commission: true },
    });
    return rows
      .reduce((sum, row) => sum.plus(toDecimal(row.commission.toString())), toDecimal('0'))
      .toString();
  }

  /**
   * Orders this platform sent the venue, by the id it sent them under.
   *
   * Only orders that were actually handed over: an order refused by risk before
   * it ever left is not one the venue should know about, and reporting it as
   * `MISSING_EXTERNAL` would be a finding about a refusal working correctly.
   */
  private async internalOrders(accountId: string) {
    const rows = await this.prisma.order.findMany({
      where: { accountId, clientOrderId: { not: null } },
      select: {
        clientOrderId: true,
        volume: true,
        filledVolume: true,
        price: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
    });
    return rows
      .filter((row): row is typeof row & { clientOrderId: string } => row.clientOrderId !== null)
      .map((row) => ({
        clientOrderId: row.clientOrderId,
        volume: row.volume.toString(),
        filledVolume: row.filledVolume.toString(),
        price: row.price === null ? null : row.price.toString(),
        status: row.status,
      }));
  }

  private async internalPositions(accountId: string) {
    const rows = await this.prisma.position.findMany({
      where: { accountId, status: 'OPEN', externalPositionId: { not: null } },
      select: { externalPositionId: true, volume: true, entryPrice: true },
    });
    return rows
      .filter(
        (row): row is typeof row & { externalPositionId: string } =>
          row.externalPositionId !== null,
      )
      .map((row) => ({
        externalPositionId: row.externalPositionId,
        volume: row.volume.toString(),
        entryPrice: row.entryPrice.toString(),
      }));
  }

  private async internalExecutions(accountId: string, since: Date) {
    const rows = await this.prisma.execution.findMany({
      where: {
        accountId,
        externalExecutionId: { not: null },
        executedAt: { gte: since },
      },
      select: { externalExecutionId: true, volume: true, price: true },
      take: 5_000,
    });
    return rows
      .filter(
        (row): row is typeof row & { externalExecutionId: string } =>
          row.externalExecutionId !== null,
      )
      .map((row) => ({
        externalExecutionId: row.externalExecutionId,
        volume: row.volume.toString(),
        price: row.price.toString(),
        /**
         * Null, and not an oversight. An `Execution` row carries no commission
         * — this platform books it against the position — so there is no
         * per-fill number to compare. `compareExecutions` says nothing when a
         * side has none, and the totals are compared instead.
         */
        commission: null,
      }));
  }

  /**
   * Record what a person decided about a discrepancy.
   *
   * Append-only, and it does not change the item. The item's status is what the
   * machine observed and stays what it observed; a resolution is a separate
   * statement about it. A discrepancy investigated and accepted, and the same
   * one reopened a month later, are two records rather than one field changing
   * its mind.
   */
  async resolve(args: {
    readonly userId: string;
    readonly itemId?: string;
    readonly findingId?: string;
    readonly decision:
      | 'FALSE_POSITIVE'
      | 'ACCEPTED_DIFFERENCE'
      | 'CORRECTED_MANUALLY'
      | 'UNDER_INVESTIGATION'
      | 'ESCALATED';
    readonly note: string;
  }): Promise<{ id: string }> {
    const named = [args.itemId, args.findingId].filter((value) => value !== undefined);
    if (named.length !== 1) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A resolution names exactly one item or one finding',
      );
    }
    if (args.note.trim().length === 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A resolution needs a reason — these are read months later by people who were not there',
      );
    }

    /**
     * Read first, inside the tenant, so a resolution cannot be attached to
     * another firm's discrepancy by pasting its id. The database's RLS would
     * refuse the write anyway; refusing here makes the answer a 404 rather than
     * a constraint violation.
     */
    if (args.itemId !== undefined) {
      const item = await this.prisma.reconciliationItem.findUnique({
        where: { id: args.itemId },
        select: { id: true },
      });
      if (item === null) {
        throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such reconciliation item');
      }
    } else {
      const finding = await this.prisma.reconciliationFinding.findUnique({
        where: { id: args.findingId },
        select: { id: true },
      });
      if (finding === null) {
        throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such finding');
      }
    }

    const record = await this.prisma.resolutionRecord.create({
      data: {
        tenantId: requireTenantId(),
        itemId: args.itemId ?? null,
        findingId: args.findingId ?? null,
        decision: args.decision,
        note: args.note.trim(),
        decidedByUserId: args.userId,
      },
      select: { id: true },
    });

    await this.audit.record({
      actorType: 'USER',
      actorId: args.userId,
      action: 'RECONCILIATION_RESOLUTION',
      resourceType: args.itemId !== undefined ? 'ReconciliationItem' : 'ReconciliationFinding',
      resourceId: args.itemId ?? args.findingId ?? null,
      after: { decision: args.decision, resolutionId: record.id },
    });

    return record;
  }
}
