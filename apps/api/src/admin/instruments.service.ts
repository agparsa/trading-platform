import { Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';

export interface InstrumentRow {
  code: string;
  description: string;
  category: string;
  quoteCurrency: string;
  enabled: boolean;
  contractSize: string;
  tickSize: string;
  pricePrecision: number;
  minVolume: string;
  maxVolume: string;
  volumeStep: string;
  marginRate: string;
  commissionPerLot: string;
  swapLongPerLot: string;
  swapShortPerLot: string;
  openPositions: number;
  restingOrders: number;
}

/** What an administrator may change. Deliberately not the whole specification. */
export interface InstrumentTerms {
  marginRate?: string;
  commissionPerLot?: string;
  swapLongPerLot?: string;
  swapShortPerLot?: string;
  maxVolume?: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * What the platform trades, and on what terms.
 *
 * The contract specification — tick size, contract size, price precision — is
 * deliberately not editable here. Those describe the instrument itself, and
 * changing one under open positions silently re-values every trade ever made in
 * it: a position opened at a tick size of 0.01 and closed at 0.001 has a P&L
 * that reconciles against nothing. They are a migration, with the trading halted
 * and the consequences thought about, not a form field.
 *
 * What *is* editable is the terms the firm sets: margin, commission, swap, and
 * the largest order it will accept. Those are commercial decisions that change
 * legitimately, and each one is audited with its old and new value.
 */
@Injectable()
export class AdminInstrumentsService {
  private readonly logger = new Logger(AdminInstrumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly symbols: SymbolsService,
  ) {}

  async list(): Promise<InstrumentRow[]> {
    const rows = await this.prisma.symbol.findMany({
      include: { spec: true },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    });

    // One grouped count each rather than a query per instrument: this list is
    // short today and there is no reason for it to get slower as it grows.
    const [positions, orders] = await Promise.all([
      this.prisma.position.groupBy({
        by: ['symbolId'],
        where: { status: { in: ['OPEN', 'CLOSING'] } },
        _count: true,
      }),
      this.prisma.order.groupBy({
        by: ['symbolId'],
        // Everything that could still fill. A resting order in a suspended
        // instrument is the thing an administrator most needs to know about.
        where: { status: { in: ['NEW', 'PENDING', 'ACCEPTED', 'TRIGGERED', 'PARTIALLY_FILLED'] } },
        _count: true,
      }),
    ]);
    const positionsBySymbol = new Map(positions.map((p) => [p.symbolId, p._count]));
    const ordersBySymbol = new Map(orders.map((o) => [o.symbolId, o._count]));

    return rows
      .filter((row) => row.spec !== null)
      .map((row) => ({
        code: row.code,
        description: row.description,
        category: row.category,
        quoteCurrency: row.quoteCurrency,
        enabled: row.enabled,
        contractSize: row.spec!.contractSize.toString(),
        tickSize: row.spec!.tickSize.toString(),
        pricePrecision: row.spec!.pricePrecision,
        minVolume: row.spec!.minVolume.toString(),
        maxVolume: row.spec!.maxVolume.toString(),
        volumeStep: row.spec!.volumeStep.toString(),
        marginRate: row.spec!.marginRate.toString(),
        commissionPerLot: row.spec!.commissionPerLot.toString(),
        swapLongPerLot: row.spec!.swapLongPerLot.toString(),
        swapShortPerLot: row.spec!.swapShortPerLot.toString(),
        openPositions: positionsBySymbol.get(row.id) ?? 0,
        restingOrders: ordersBySymbol.get(row.id) ?? 0,
      }));
  }

  /**
   * Suspend or resume an instrument.
   *
   * Disabling stops new orders. It does **not** close what is already open, and
   * must not: liquidating a trader's positions because an administrator
   * suspended an instrument would turn an operational decision into a
   * market one made on their behalf. The count is returned so whoever pressed
   * the button can see what they have left stranded, and decide.
   */
  async setEnabled(
    actorId: string,
    code: string,
    enabled: boolean,
    reason: string,
  ): Promise<{ code: string; enabled: boolean; openPositions: number }> {
    const trimmed = reason.trim();
    if (trimmed.length < 8) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Give a reason of at least 8 characters. It goes in the audit trail.',
      );
    }

    const symbol = await this.prisma.symbol.findUnique({ where: { code } });
    if (symbol === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }

    const openPositions = await this.prisma.position.count({
      where: { symbolId: symbol.id, status: { in: ['OPEN', 'CLOSING'] } },
    });

    await this.prisma.symbol.update({ where: { code }, data: { enabled } });
    await this.symbols.reload();

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: enabled ? 'instrument.enabled' : 'instrument.disabled',
      resourceType: 'instrument',
      resourceId: code,
      before: { enabled: symbol.enabled },
      after: { enabled, reason: trimmed, openPositionsAtChange: openPositions },
    });

    this.logger.warn(
      `${code} ${enabled ? 'enabled' : 'disabled'} by ${actorId}: ${trimmed} ` +
        `(${openPositions} position(s) open)`,
    );
    return { code, enabled, openPositions };
  }

  /**
   * Change the terms the firm trades this instrument on.
   *
   * Raising the margin rate is the one to be careful with: it changes the margin
   * required by every position already open in this instrument, and can put an
   * account into margin call without anyone touching that account. So the reply
   * says how many positions are affected, and the audit entry carries both the
   * old and the new value — an entry saying only "margin changed" is no use at
   * all six months later.
   */
  async setTerms(
    actorId: string,
    code: string,
    terms: InstrumentTerms,
    reason: string,
  ): Promise<{ code: string; changed: string[]; openPositions: number }> {
    const trimmed = reason.trim();
    if (trimmed.length < 8) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Give a reason of at least 8 characters. It goes in the audit trail.',
      );
    }

    const symbol = await this.prisma.symbol.findUnique({
      where: { code },
      include: { spec: true },
    });
    if (symbol === null || symbol.spec === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }

    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const data: Record<string, string> = {};

    for (const [field, value] of Object.entries(terms)) {
      if (value === undefined) continue;
      if (!DECIMAL.test(value)) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `${field} must be a non-negative decimal`,
          { field, value },
        );
      }
      const current = (symbol.spec as unknown as Record<string, { toString(): string }>)[
        field
      ]?.toString();
      if (current === value) continue; // nothing to record
      before[field] = current ?? '';
      after[field] = value;
      data[field] = value;
    }

    if (Object.keys(data).length === 0) {
      return { code, changed: [], openPositions: 0 };
    }

    /**
     * A margin rate of zero means an unlimited position on an empty account.
     * There is no legitimate configuration where that is what somebody meant.
     */
    if (data['marginRate'] !== undefined && Number(data['marginRate']) <= 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A margin rate of zero would let an account open a position of any size against nothing.',
        { code },
      );
    }

    const openPositions = await this.prisma.position.count({
      where: { symbolId: symbol.id, status: { in: ['OPEN', 'CLOSING'] } },
    });

    await this.prisma.symbolSpec.update({ where: { symbolId: symbol.id }, data });
    await this.symbols.reload();

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'instrument.terms_changed',
      resourceType: 'instrument',
      resourceId: code,
      before,
      after: { ...after, reason: trimmed, openPositionsAtChange: openPositions },
    });

    this.logger.warn(
      `${code} terms changed by ${actorId} (${Object.keys(data).join(', ')}): ${trimmed} ` +
        `(${openPositions} position(s) open)`,
    );
    return { code, changed: Object.keys(data), openPositions };
  }
}
