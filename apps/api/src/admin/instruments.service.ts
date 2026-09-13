import { Injectable, Logger } from '@nestjs/common';
import { toDecimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { requireTenantId } from '@tp/tenancy';

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
      include: { spec: true, tenantTerms: { where: { tenantId: requireTenantId() } } },
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

    /**
     * Shown as the tenant's own terms where it has set them, and the platform's
     * where it has not.
     *
     * An administrator reading this screen is reading what their firm trades
     * on. Showing the platform default beside a per-tenant override would be
     * two numbers with no indication of which one is charged.
     */
    return rows
      .filter((row) => row.spec !== null)
      .map((row) => {
        const own = row.tenantTerms[0] as Record<string, unknown> | undefined;
        const value = (field: string, fallback: { toString(): string }): string => {
          const override = own?.[field] as { toString(): string } | null | undefined;
          return (override ?? fallback).toString();
        };
        return {
          code: row.code,
          description: row.description,
          category: row.category,
          // Enabled for this firm: the platform must offer it and the firm must
          // not have declined it.
          enabled: row.enabled && ((own?.['enabled'] as boolean | undefined) ?? true),
          quoteCurrency: row.quoteCurrency,
          contractSize: row.spec!.contractSize.toString(),
          tickSize: row.spec!.tickSize.toString(),
          pricePrecision: row.spec!.pricePrecision,
          minVolume: row.spec!.minVolume.toString(),
          maxVolume: value('maxVolume', row.spec!.maxVolume),
          volumeStep: row.spec!.volumeStep.toString(),
          marginRate: value('marginRate', row.spec!.marginRate),
          commissionPerLot: value('commissionPerLot', row.spec!.commissionPerLot),
          swapLongPerLot: value('swapLongPerLot', row.spec!.swapLongPerLot),
          swapShortPerLot: value('swapShortPerLot', row.spec!.swapShortPerLot),
          openPositions: positionsBySymbol.get(row.id) ?? 0,
          restingOrders: ordersBySymbol.get(row.id) ?? 0,
        };
      });
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
  /**
   * The week an instrument trades, as stored.
   *
   * Windows are per weekday in the session's own IANA zone. Returned as they
   * are rather than expanded into the caller's time, because an operator
   * editing a session is editing the venue's week, not their own afternoon.
   */
  async sessions(code: string): Promise<SessionView> {
    const symbol = await this.prisma.symbol.findUnique({
      where: { code: code.toUpperCase() },
      include: { sessions: { orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }] } },
    });
    if (symbol === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }
    return {
      code: symbol.code,
      timezone: symbol.sessions[0]?.timezone ?? 'UTC',
      windows: symbol.sessions.map((row) => ({
        dayOfWeek: row.dayOfWeek,
        openMinute: row.openMinute,
        closeMinute: row.closeMinute,
      })),
    };
  }

  /**
   * Replaces the whole week.
   *
   * Wholesale, not window by window. A trading week is one thing: editing it a
   * window at a time means a moment where Monday has been saved and Tuesday
   * has not, and that moment is a market that is open when it should be shut.
   * Sending the week entire also makes "close on Fridays an hour earlier" a
   * single audited change rather than a sequence somebody could stop halfway.
   *
   * Sessions belong to the instrument, not to a firm — they are when the
   * *venue* trades — so this is a platform act, refused from a broker.
   * A firm that wants an instrument shut simply disables it for itself.
   */
  async setSessions(
    actorId: string,
    code: string,
    input: { timezone: string; windows: readonly SessionWindow[] },
    reason: string,
  ): Promise<SessionView> {
    const trimmed = reason.trim();
    if (trimmed.length < 8) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Give a reason of at least 8 characters. It goes in the audit trail.',
      );
    }
    await this.assertPlatform();

    const symbol = await this.prisma.symbol.findUnique({
      where: { code: code.toUpperCase() },
      include: { sessions: true },
    });
    if (symbol === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }

    const timezone = input.timezone.trim();
    assertTimezone(timezone);
    const windows = normaliseWindows(input.windows);

    const before = await this.sessions(symbol.code);
    await this.prisma.$transaction(async (tx) => {
      await tx.marketSession.deleteMany({ where: { symbolId: symbol.id } });
      if (windows.length > 0) {
        await tx.marketSession.createMany({
          data: windows.map((window) => ({
            symbolId: symbol.id,
            timezone,
            dayOfWeek: window.dayOfWeek,
            openMinute: window.openMinute,
            closeMinute: window.closeMinute,
          })),
        });
      }
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'instrument.sessions_changed',
      resourceType: 'Symbol',
      resourceId: symbol.id,
      before: { timezone: before.timezone, windows: before.windows as never },
      after: { code: symbol.code, timezone, windows: windows as never, reason: trimmed },
    });

    /**
     * The cache holds the session the engine checks before every order, so it
     * is refreshed here. Without this the change would take effect at the next
     * restart — which is exactly the kind of "it did not apply" that gets
     * blamed on the market.
     */
    await this.symbols.reload();
    this.logger.log(
      { code: symbol.code, timezone, windows: windows.length, actorId },
      'An instrument’s trading week was changed',
    );
    return { code: symbol.code, timezone, windows };
  }

  /** Sessions are the venue's week, so only the platform sets them. */
  private async assertPlatform(): Promise<void> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: requireTenantId() },
      select: { kind: true },
    });
    if (tenant?.kind !== 'PLATFORM') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'Trading sessions are when the venue trades, so they are set from the platform. ' +
          'A firm that wants this instrument shut can disable it for itself.',
      );
    }
  }

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

    const tenantId = requireTenantId();
    const symbol = await this.prisma.symbol.findUnique({ where: { code } });
    if (symbol === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }
    if (!symbol.enabled && enabled) {
      /**
       * A tenant may decline an instrument the platform offers. It may not
       * offer one the platform has withdrawn — a withdrawn instrument is
       * withdrawn because it cannot be priced or settled, and a firm's wish to
       * trade it does not change that.
       */
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'The platform has withdrawn this instrument; it cannot be offered until that is reversed.',
        { code },
      );
    }

    const own = await this.prisma.tenantSymbolTerms.findUnique({
      where: { tenantId_symbolId: { tenantId, symbolId: symbol.id } },
    });
    const wasEnabled = own?.enabled ?? true;

    /**
     * Only this tenant's positions.
     *
     * The number goes in the audit record and in the reply so whoever pressed
     * the button can see what they have just re-margined. Counting another
     * firm's positions would be both a leak and a lie.
     */
    const openPositions = await this.prisma.position.count({
      where: { symbolId: symbol.id, status: { in: ['OPEN', 'CLOSING'] } },
    });

    await this.prisma.tenantSymbolTerms.upsert({
      where: { tenantId_symbolId: { tenantId, symbolId: symbol.id } },
      create: { tenantId, symbolId: symbol.id, enabled },
      update: { enabled },
    });
    await this.symbols.reload();

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: enabled ? 'instrument.enabled' : 'instrument.disabled',
      resourceType: 'instrument',
      resourceId: code,
      before: { enabled: wasEnabled },
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

    const tenantId = requireTenantId();
    const symbol = await this.prisma.symbol.findUnique({
      where: { code },
      include: { spec: true },
    });
    if (symbol === null || symbol.spec === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such instrument', { code });
    }

    /**
     * What this tenant is on today: its own terms where it has set them, and the
     * platform's where it has not.
     *
     * The comparison below is against *this* tenant's effective values, not the
     * platform's, so "no change" means no change for the firm making the request.
     */
    const existing = await this.prisma.tenantSymbolTerms.findUnique({
      where: { tenantId_symbolId: { tenantId, symbolId: symbol.id } },
    });
    const effective = (field: string): string | undefined => {
      const own = (existing as unknown as Record<string, { toString(): string } | null> | null)?.[
        field
      ];
      if (own !== null && own !== undefined) return own.toString();
      return (symbol.spec as unknown as Record<string, { toString(): string }>)[field]?.toString();
    };

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
      const current = effective(field);
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
    if (data['marginRate'] !== undefined && toDecimal(String(data['marginRate'])).lte(0)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A margin rate of zero would let an account open a position of any size against nothing.',
        { code },
      );
    }

    const openPositions = await this.prisma.position.count({
      where: { symbolId: symbol.id, status: { in: ['OPEN', 'CLOSING'] } },
    });

    /**
     * Written to this tenant's own row, never to `symbol_specs`.
     *
     * `symbol_specs` is the platform's, and one firm's administrator raising a
     * margin rate there would put another firm's accounts into margin call
     * without anybody touching them. That was true before this change and is
     * the reason for it.
     */
    await this.prisma.tenantSymbolTerms.upsert({
      where: { tenantId_symbolId: { tenantId, symbolId: symbol.id } },
      create: { tenantId, symbolId: symbol.id, ...data },
      update: data,
    });
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


export interface SessionWindow {
  /** 0 = Sunday … 6 = Saturday. */
  readonly dayOfWeek: number;
  /** Minutes from midnight in the session's own timezone. */
  readonly openMinute: number;
  readonly closeMinute: number;
}

export interface SessionView {
  readonly code: string;
  readonly timezone: string;
  readonly windows: readonly SessionWindow[];
}

/**
 * A real IANA zone, checked against the platform's own tz database rather than
 * a list somebody typed. `Intl` throws for a name it does not know, which is
 * the only check that stays correct as zones are added and renamed.
 */
export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new DomainError(
      TradingErrorCode.VALIDATION_FAILED,
      `${timezone} is not a timezone this system knows. Use an IANA name such as Europe/London.`,
      { timezone },
    );
  }
}

/**
 * Validates and orders the week.
 *
 * Overlaps are refused rather than merged. Two windows that overlap mean
 * somebody has described the week twice and disagreed with themselves, and
 * silently taking the union would hide which of the two they meant — while
 * making "why is it open at 3am" unanswerable from the row.
 */
export function normaliseWindows(windows: readonly SessionWindow[]): SessionWindow[] {
  const cleaned = windows.map((window) => {
    if (!Number.isInteger(window.dayOfWeek) || window.dayOfWeek < 0 || window.dayOfWeek > 6) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A day must be 0 (Sunday) to 6 (Saturday).',
        { dayOfWeek: String(window.dayOfWeek) },
      );
    }
    for (const [name, value] of [
      ['openMinute', window.openMinute],
      ['closeMinute', window.closeMinute],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 1440) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `${name} must be a whole number of minutes from 0 to 1440.`,
          { [name]: String(value) },
        );
      }
    }
    if (window.closeMinute <= window.openMinute) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A window must close after it opens. A session that crosses midnight is two windows: ' +
          'one to 1440 on the first day, one from 0 on the next.',
        { openMinute: String(window.openMinute), closeMinute: String(window.closeMinute) },
      );
    }
    return {
      dayOfWeek: window.dayOfWeek,
      openMinute: window.openMinute,
      closeMinute: window.closeMinute,
    };
  });

  const sorted = [...cleaned].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.openMinute - b.openMinute,
  );
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as SessionWindow;
    const current = sorted[i] as SessionWindow;
    if (current.dayOfWeek === previous.dayOfWeek && current.openMinute < previous.closeMinute) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Two windows on day ${current.dayOfWeek} overlap. Describe the week once.`,
        { dayOfWeek: String(current.dayOfWeek) },
      );
    }
  }
  return sorted;
}
