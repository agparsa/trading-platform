import { Injectable } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/** The most rows any one of these queries will return, whatever is asked for. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface BlotterQuery {
  readonly accountId?: string;
  readonly accountNumber?: string;
  readonly symbol?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly status?: string;
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit?: number;
  /** From a previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface Page<T> {
  readonly rows: readonly T[];
  /** Null when this is the last page. Opaque; pass it back verbatim. */
  readonly nextCursor: string | null;
}

export interface OrderRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountNumber: string;
  readonly ownerEmail: string;
  readonly symbol: string;
  readonly side: string;
  readonly type: string;
  readonly status: string;
  readonly volume: string;
  readonly filledVolume: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly rejectionCode: string | null;
  /** The desk that placed it, when an operator did. */
  readonly placedByMasterAccountId: string | null;
  readonly clientOrderId: string | null;
  readonly externalOrderId: string | null;
  readonly createdAt: string;
}

export interface PositionRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountNumber: string;
  readonly ownerEmail: string;
  readonly symbol: string;
  readonly side: string;
  readonly status: string;
  readonly volume: string;
  readonly entryPrice: string;
  readonly currentPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly margin: string;
  readonly commission: string;
  readonly swap: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

export interface TradeRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountNumber: string;
  readonly ownerEmail: string;
  readonly symbol: string;
  readonly side: string;
  readonly volume: string;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly grossPnl: string;
  readonly commission: string;
  readonly swap: string;
  readonly netPnl: string;
  readonly entryTime: string;
  readonly exitTime: string;
}

export interface OrderEventRow {
  readonly id: string;
  readonly type: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * The firm's own book: every order, position and closed trade in the tenant.
 *
 * ## Why this did not exist before, and why it has to
 *
 * Every trading listing on the platform is account-scoped and
 * ownership-checked, which is right for a trader and useless for the person
 * running the firm. Answering "what is open across the book right now" or
 * "why was that order rejected at 14:32" meant a database console. A broker
 * cannot run a desk from a database console, and a support agent should not
 * have one.
 *
 * ## Tenant-wide is not permission-free
 *
 * These read across every account in the firm, so they take
 * `ACCOUNTS_READ_ANY` — the permission that already means "read across
 * accounts". Deliberately **not** `ORDERS_READ`, which every trader holds
 * because it is what lets them see their own orders: guarding a
 * firm-wide blotter with it would show one trader everyone else's book. That
 * mistake was made once already, on the venue-recovery console, and caught by
 * the pentest rather than the suite.
 *
 * The tenancy extension scopes every query here to the caller's firm, so
 * "tenant-wide" means one firm's book and never the platform's.
 *
 * ## Paging
 *
 * Keyset, not offset. A blotter is read while orders are still arriving, and
 * `skip`/`take` over a moving table shows some rows twice and skips others —
 * which in a book of orders is not a cosmetic problem. The cursor is
 * `createdAt` and `id` together, because two orders can share a millisecond.
 */
@Injectable()
export class BlotterService {
  constructor(private readonly prisma: PrismaService) {}

  async orders(query: BlotterQuery): Promise<Page<OrderRow>> {
    const take = limitOf(query);
    const rows = await this.prisma.order.findMany({
      where: {
        ...(await this.accountFilter(query)),
        ...(query.symbol === undefined ? {} : { symbol: { code: query.symbol.toUpperCase() } }),
        ...(query.side === undefined ? {} : { side: query.side }),
        ...(query.status === undefined ? {} : { status: query.status as never }),
        ...createdAtFilter(query),
        ...keyset(query.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        symbol: { select: { code: true } },
        account: { select: { number: true, user: { select: { email: true } } } },
      },
    });

    return page(rows, take, (row) => ({
      id: row.id,
      accountId: row.accountId,
      accountNumber: row.account.number,
      ownerEmail: row.account.user.email,
      symbol: row.symbol.code,
      side: row.side,
      type: row.type,
      status: row.status,
      volume: row.volume.toString(),
      filledVolume: row.filledVolume.toString(),
      price: row.price?.toString() ?? null,
      stopPrice: row.stopPrice?.toString() ?? null,
      stopLoss: row.stopLoss?.toString() ?? null,
      takeProfit: row.takeProfit?.toString() ?? null,
      rejectionCode: row.rejectionCode,
      placedByMasterAccountId: row.placedByMasterAccountId,
      clientOrderId: row.clientOrderId,
      externalOrderId: row.externalOrderId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async positions(query: BlotterQuery): Promise<Page<PositionRow>> {
    const take = limitOf(query);
    const rows = await this.prisma.position.findMany({
      where: {
        ...(await this.accountFilter(query)),
        ...(query.symbol === undefined ? {} : { symbol: { code: query.symbol.toUpperCase() } }),
        ...(query.side === undefined ? {} : { side: query.side }),
        // Open by default. A blotter that opened on every position ever taken
        // would answer a question nobody asked and take a while doing it.
        status: (query.status ?? 'OPEN') as never,
        ...openedAtFilter(query),
        ...keyset(query.cursor, 'openedAt'),
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        symbol: { select: { code: true } },
        account: { select: { number: true, user: { select: { email: true } } } },
      },
    });

    return page(
      rows,
      take,
      (row) => ({
      id: row.id,
      accountId: row.accountId,
      accountNumber: row.account.number,
      ownerEmail: row.account.user.email,
      symbol: row.symbol.code,
      side: row.side,
      status: row.status,
      volume: row.volume.toString(),
      entryPrice: row.entryPrice.toString(),
      currentPrice: row.currentPrice?.toString() ?? null,
      stopLoss: row.stopLoss?.toString() ?? null,
      takeProfit: row.takeProfit?.toString() ?? null,
      margin: row.margin.toString(),
      commission: row.commission.toString(),
      swap: row.swap.toString(),
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      }),
      'openedAt',
    );
  }

  /** Closed round trips, with what each one actually cost. */
  async trades(query: BlotterQuery): Promise<Page<TradeRow>> {
    const take = limitOf(query);
    const rows = await this.prisma.trade.findMany({
      where: {
        ...(await this.accountFilter(query)),
        ...(query.symbol === undefined ? {} : { symbol: { code: query.symbol.toUpperCase() } }),
        ...(query.side === undefined ? {} : { side: query.side }),
        ...(query.sinceMs === undefined && query.untilMs === undefined
          ? {}
          : {
              exitTime: {
                ...(query.sinceMs === undefined ? {} : { gte: new Date(query.sinceMs) }),
                ...(query.untilMs === undefined ? {} : { lte: new Date(query.untilMs) }),
              },
            }),
        ...keyset(query.cursor, 'exitTime'),
      },
      orderBy: [{ exitTime: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        symbol: { select: { code: true } },
        account: { select: { number: true, user: { select: { email: true } } } },
      },
    });

    return page(
      rows,
      take,
      (row) => ({
        id: row.id,
        accountId: row.accountId,
        accountNumber: row.account.number,
        ownerEmail: row.account.user.email,
        symbol: row.symbol.code,
        side: row.side,
        volume: row.volume.toString(),
        entryPrice: row.entryPrice.toString(),
        exitPrice: row.exitPrice.toString(),
        grossPnl: row.grossPnl.toString(),
        commission: row.commission.toString(),
        swap: row.swap.toString(),
        netPnl: row.netPnl.toString(),
        entryTime: row.entryTime.toISOString(),
        exitTime: row.exitTime.toISOString(),
      }),
      'exitTime',
    );
  }

  /**
   * Everything that happened to one order.
   *
   * The answer to "why was that rejected", which is the question a support
   * agent is actually asked. Order events are written by the trading path at
   * every transition and are never edited, so this is the record rather than a
   * reconstruction.
   */
  async orderHistory(orderId: string): Promise<{
    readonly order: OrderRow;
    readonly events: readonly OrderEventRow[];
  }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId },
      include: {
        symbol: { select: { code: true } },
        account: { select: { number: true, user: { select: { email: true } } } },
      },
    });
    if (order === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such order', { orderId });
    }
    const events = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      order: {
        id: order.id,
        accountId: order.accountId,
        accountNumber: order.account.number,
        ownerEmail: order.account.user.email,
        symbol: order.symbol.code,
        side: order.side,
        type: order.type,
        status: order.status,
        volume: order.volume.toString(),
        filledVolume: order.filledVolume.toString(),
        price: order.price?.toString() ?? null,
        stopPrice: order.stopPrice?.toString() ?? null,
        stopLoss: order.stopLoss?.toString() ?? null,
        takeProfit: order.takeProfit?.toString() ?? null,
        rejectionCode: order.rejectionCode,
        placedByMasterAccountId: order.placedByMasterAccountId,
        clientOrderId: order.clientOrderId,
        externalOrderId: order.externalOrderId,
        createdAt: order.createdAt.toISOString(),
      },
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /**
   * `accountNumber` is resolved to an id rather than joined on.
   *
   * A blotter is searched by the number a person can read off a ticket, and
   * resolving it once here keeps the three queries above identical in shape.
   * An unknown number filters to nothing rather than to everything — the
   * failure that would otherwise show a support agent the whole firm's book
   * when they mistyped one digit.
   */
  private async accountFilter(query: BlotterQuery): Promise<{ accountId?: string }> {
    if (query.accountId !== undefined) return { accountId: query.accountId };
    if (query.accountNumber === undefined) return {};
    const account = await this.prisma.account.findFirst({
      where: { number: query.accountNumber.trim().toUpperCase() },
      select: { id: true },
    });
    return { accountId: account?.id ?? '00000000-0000-4000-8000-000000000000' };
  }
}

function limitOf(query: BlotterQuery): number {
  const asked = query.limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(asked), 1), MAX_LIMIT);
}

function openedAtFilter(query: BlotterQuery): { openedAt?: { gte?: Date; lte?: Date } } {
  if (query.sinceMs === undefined && query.untilMs === undefined) return {};
  return {
    openedAt: {
      ...(query.sinceMs === undefined ? {} : { gte: new Date(query.sinceMs) }),
      ...(query.untilMs === undefined ? {} : { lte: new Date(query.untilMs) }),
    },
  };
}

function createdAtFilter(query: BlotterQuery): { createdAt?: { gte?: Date; lte?: Date } } {
  if (query.sinceMs === undefined && query.untilMs === undefined) return {};
  return {
    createdAt: {
      ...(query.sinceMs === undefined ? {} : { gte: new Date(query.sinceMs) }),
      ...(query.untilMs === undefined ? {} : { lte: new Date(query.untilMs) }),
    },
  };
}

/**
 * The keyset predicate: strictly older than the cursor row.
 *
 * Written as an OR on (time, id) rather than a compound comparison because
 * Prisma has no tuple comparison, and because two rows sharing a millisecond
 * is not rare in a book — without the id tiebreak such a pair would either
 * repeat or vanish across a page boundary.
 */
type KeyField = 'createdAt' | 'exitTime' | 'openedAt';

function keyset(cursor: string | undefined, field: KeyField = 'createdAt') {
  if (cursor === undefined) return {};
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'That page marker is not readable', {
      cursor,
    });
  }
  return {
    OR: [
      { [field]: { lt: decoded.at } },
      { [field]: decoded.at, id: { lt: decoded.id } },
    ],
  };
}

function page<Row extends { id: string } & Partial<Record<KeyField, Date>>, Out>(
  rows: readonly Row[],
  take: number,
  map: (row: Row) => Out,
  field: KeyField = 'createdAt',
): Page<Out> {
  const hasMore = rows.length > take;
  const visible = hasMore ? rows.slice(0, take) : rows;
  const last = visible[visible.length - 1];
  const at = last?.[field];
  return {
    rows: visible.map(map),
    nextCursor: hasMore && last !== undefined && at !== undefined ? encodeCursor(at, last.id) : null,
  };
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (iso === undefined || id === undefined) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}
