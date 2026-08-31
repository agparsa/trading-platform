import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { assertValidSpec, type SymbolSpec } from '@tp/financial-core';
import type { InstrumentDefinition, TradingSession } from '@tp/market-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant, withoutTenantScope } from '@tp/tenancy';

export interface InstrumentSummary {
  code: string;
  description: string;
  category: string;
  quoteCurrency: string;
  enabled: boolean;
  spec: SymbolSpec;
}

/**
 * Instrument definitions, loaded once and held in memory.
 *
 * Contract specifications change rarely and are read on every single order,
 * every margin calculation and every tick. Re-reading them from PostgreSQL each
 * time would put a query in the hottest path in the system for no benefit.
 * `reload()` refreshes the cache after an administrative change.
 */
@Injectable()
export class SymbolsService implements OnModuleInit {
  private readonly logger = new Logger(SymbolsService.name);
  /** The platform's own terms: what a tenant gets if it has set none of its own. */
  private byCode = new Map<string, InstrumentDefinition>();
  private idByCode = new Map<string, string>();
  /**
   * Per-tenant definitions, fully resolved at load time rather than merged per
   * call.
   *
   * `require()` is on the hottest path in the system — every order, every margin
   * calculation, every tick — so it must stay a map lookup. Building a merged
   * definition on each call would put object allocation in that path to answer
   * a question whose answer changes when an administrator edits a form.
   */
  private byTenant = new Map<string, Map<string, InstrumentDefinition>>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<number> {
    const rows = await this.prisma.symbol.findMany({
      include: { spec: true, sessions: true },
      orderBy: { code: 'asc' },
    });

    const byCode = new Map<string, InstrumentDefinition>();
    const idByCode = new Map<string, string>();

    for (const row of rows) {
      if (row.spec === null) {
        // A symbol without a contract specification cannot be priced or sized.
        // Skipping it loudly beats letting an order reach the engine with
        // undefined tick and lot rules.
        this.logger.error(`Symbol ${row.code} has no specification and was not loaded`);
        continue;
      }

      const spec: SymbolSpec = {
        code: row.code,
        description: row.description,
        quoteCurrency: row.quoteCurrency,
        contractSize: row.spec.contractSize.toString(),
        tickSize: row.spec.tickSize.toString(),
        pricePrecision: row.spec.pricePrecision,
        volumeStep: row.spec.volumeStep.toString(),
        volumePrecision: row.spec.volumePrecision,
        minVolume: row.spec.minVolume.toString(),
        maxVolume: row.spec.maxVolume.toString(),
        marginRate: row.spec.marginRate.toString(),
        commissionPerLot: row.spec.commissionPerLot.toString(),
        swapLongPerLot: row.spec.swapLongPerLot.toString(),
        swapShortPerLot: row.spec.swapShortPerLot.toString(),
        enabled: row.enabled,
      };

      try {
        // Validated once, here, so every downstream calculation can trust it.
        assertValidSpec(spec);
      } catch (error) {
        this.logger.error(
          `Symbol ${row.code} has an invalid specification and was not loaded: ${(error as Error).message}`,
        );
        continue;
      }

      const session: TradingSession = {
        symbol: row.code,
        timezone: row.sessions[0]?.timezone ?? 'UTC',
        windows: row.sessions
          .map((window) => ({
            day: window.dayOfWeek,
            openMinute: window.openMinute,
            closeMinute: window.closeMinute,
          }))
          .sort((a, b) => a.day - b.day || a.openMinute - b.openMinute),
      };

      byCode.set(row.code, { spec, session });
      idByCode.set(row.code, row.id);
    }

    this.byCode = byCode;
    this.idByCode = idByCode;
    this.byTenant = await this.resolveTenantTerms(byCode, idByCode);
    this.logger.log(
      `Loaded ${byCode.size} instrument(s); ${this.byTenant.size} tenant(s) with terms of their own`,
    );
    return byCode.size;
  }

  /**
   * Applies each tenant's overrides to the platform definitions.
   *
   * Reads across tenants, and says so: the cache is one process-wide structure
   * serving every request, so building it per tenant on demand would mean a
   * database read on the first order of every tenant after every restart.
   *
   * A null column means "the platform's value", so a tenant that overrode only
   * the margin rate keeps following the platform's commission when it changes.
   * Freezing the rest at write time would be the other, wrong reading of an
   * unspecified field.
   */
  private async resolveTenantTerms(
    base: Map<string, InstrumentDefinition>,
    idByCode: Map<string, string>,
  ): Promise<Map<string, Map<string, InstrumentDefinition>>> {
    const rows = await withoutTenantScope(
      'the instrument cache is process-wide and serves every tenant',
      () => this.prisma.tenantSymbolTerms.findMany(),
    );

    const codeById = new Map([...idByCode].map(([code, id]) => [id, code]));
    const resolved = new Map<string, Map<string, InstrumentDefinition>>();

    for (const row of rows) {
      const code = codeById.get(row.symbolId);
      const platform = code === undefined ? undefined : base.get(code);
      if (code === undefined || platform === undefined) {
        // Terms for an instrument that failed to load, or has been removed.
        // Skipped rather than half-applied.
        continue;
      }

      const spec: SymbolSpec = {
        ...platform.spec,
        marginRate: row.marginRate?.toString() ?? platform.spec.marginRate,
        commissionPerLot: row.commissionPerLot?.toString() ?? platform.spec.commissionPerLot,
        swapLongPerLot: row.swapLongPerLot?.toString() ?? platform.spec.swapLongPerLot,
        swapShortPerLot: row.swapShortPerLot?.toString() ?? platform.spec.swapShortPerLot,
        maxVolume: row.maxVolume?.toString() ?? platform.spec.maxVolume,
        // A tenant may decline an instrument the platform offers. It may not
        // offer one the platform has withdrawn, so this is an AND.
        enabled: platform.spec.enabled && row.enabled,
      };

      try {
        assertValidSpec(spec);
      } catch (error) {
        this.logger.error(
          `Tenant ${row.tenantId} has invalid terms for ${code} and they were not applied: ${(error as Error).message}`,
        );
        continue;
      }

      const forTenant = resolved.get(row.tenantId) ?? new Map(base);
      forTenant.set(code, { spec, session: platform.session });
      resolved.set(row.tenantId, forTenant);
    }

    return resolved;
  }

  /**
   * The instrument table the caller's tenant trades on.
   *
   * Falls back to the platform's when the tenant has set no terms, which is
   * every tenant until somebody edits one — so the common path is the same map
   * it always was.
   */
  private table(): Map<string, InstrumentDefinition> {
    const tenant = currentTenant();
    if (tenant === undefined) return this.byCode;
    return this.byTenant.get(tenant.tenantId) ?? this.byCode;
  }

  list(): readonly InstrumentDefinition[] {
    return [...this.table().values()];
  }

  /** Throws `UNKNOWN_SYMBOL` rather than returning null: every caller must handle it. */
  require(code: string): InstrumentDefinition {
    const instrument = this.table().get(code.toUpperCase());
    if (instrument === undefined) {
      throw new DomainError(TradingErrorCode.UNKNOWN_SYMBOL, `Unknown symbol '${code}'`, {
        symbol: code,
      });
    }
    return instrument;
  }

  find(code: string): InstrumentDefinition | undefined {
    return this.table().get(code.toUpperCase());
  }

  requireSpec(code: string): SymbolSpec {
    return this.require(code).spec;
  }

  /** Database id for a symbol code. Never exposed through the API. */
  requireId(code: string): string {
    const id = this.idByCode.get(code.toUpperCase());
    if (id === undefined) {
      throw new DomainError(TradingErrorCode.UNKNOWN_SYMBOL, `Unknown symbol '${code}'`, {
        symbol: code,
      });
    }
    return id;
  }

  codes(): readonly string[] {
    return [...this.byCode.keys()];
  }
}
