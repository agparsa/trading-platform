import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { assertValidSpec, type SymbolSpec } from '@tp/financial-core';
import type { InstrumentDefinition, TradingSession } from '@tp/market-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';

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
  private byCode = new Map<string, InstrumentDefinition>();
  private idByCode = new Map<string, string>();

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
    this.logger.log(`Loaded ${byCode.size} instrument(s)`);
    return byCode.size;
  }

  list(): readonly InstrumentDefinition[] {
    return [...this.byCode.values()];
  }

  /** Throws `UNKNOWN_SYMBOL` rather than returning null: every caller must handle it. */
  require(code: string): InstrumentDefinition {
    const instrument = this.byCode.get(code.toUpperCase());
    if (instrument === undefined) {
      throw new DomainError(TradingErrorCode.UNKNOWN_SYMBOL, `Unknown symbol '${code}'`, {
        symbol: code,
      });
    }
    return instrument;
  }

  find(code: string): InstrumentDefinition | undefined {
    return this.byCode.get(code.toUpperCase());
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
