import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { BrokerInstrument } from '@tp/broker-sdk';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BrokerConnectionsService } from './broker-connections.service';

export interface MappingView {
  readonly id: string;
  readonly symbolId: string;
  readonly symbolCode: string;
  readonly externalSymbol: string;
  readonly contractSize: string | null;
  readonly volumeStep: string | null;
  readonly minVolume: string | null;
  readonly maxVolume: string | null;
  readonly priceDecimals: number | null;
  readonly enabled: boolean;
  readonly syncedAt: Date | null;
}

export interface CatalogueEntry extends BrokerInstrument {
  /** The platform symbol this is already mapped to, if any. */
  readonly mappedTo: string | null;
}

/**
 * Which of the platform's instruments this venue trades, and what it calls
 * them.
 *
 * ## Nothing is guessed
 *
 * `XAUUSD` here may be `XAUUSD.m`, `GOLD` or `XAU/USD` there, with its own
 * lot step and price precision. A name that looks similar is not a mapping: a
 * venue with `XAUUSD` (spot, 100oz) and `XAUUSD.f` (futures) would make
 * "obvious" matching a way to trade the wrong contract. So a mapping is an
 * explicit, audited row, and an instrument without one **cannot be traded on
 * that connection** — the refusal names what is missing rather than falling
 * back to the platform's own symbol.
 *
 * `suggest()` offers candidates by normalised name for a human to confirm.
 * It proposes; it does not map.
 *
 * ## The venue's terms are read, not trusted to stay
 *
 * `contractSize`, `volumeStep` and the rest are copied from the venue's
 * catalogue at sync so an order the venue would reject can be refused before
 * it is sent — and so a change on the venue's side (a lot step that doubles
 * overnight) is visible as a difference rather than as a run of rejections.
 * The platform's own terms still govern margin and P&L; these are the
 * venue's, kept beside them.
 */
@Injectable()
export class BrokerMappingService {
  private readonly logger = new Logger(BrokerMappingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly connections: BrokerConnectionsService,
  ) {}

  async list(connectionId: string): Promise<readonly MappingView[]> {
    const rows = await this.prisma.brokerInstrumentMapping.findMany({
      where: { connectionId },
      include: { symbol: { select: { code: true } } },
      orderBy: { externalSymbol: 'asc' },
    });
    return rows.map(toView);
  }

  /**
   * What the venue says it trades, with what is already mapped marked.
   *
   * Read live rather than cached: a catalogue is what a person maps against,
   * and a stale one is how an instrument gets mapped to a symbol the venue
   * retired last month.
   */
  async catalogue(connectionId: string): Promise<readonly CatalogueEntry[]> {
    const instruments = await this.connections.withAdapter(connectionId, (adapter) =>
      adapter.listInstruments(),
    );
    const mapped = await this.prisma.brokerInstrumentMapping.findMany({
      where: { connectionId },
      include: { symbol: { select: { code: true } } },
    });
    const byExternal = new Map(mapped.map((row) => [row.externalSymbol, row.symbol.code]));
    return instruments.map((instrument) => ({
      ...instrument,
      mappedTo: byExternal.get(instrument.externalSymbol) ?? null,
    }));
  }

  /**
   * Candidate pairings, by normalised name. A suggestion is a shortlist for a
   * person, never a mapping: `confirm` is a separate, audited act.
   */
  async suggest(connectionId: string): Promise<readonly { symbolCode: string; externalSymbol: string }[]> {
    const [instruments, symbols, existing] = await Promise.all([
      this.connections.withAdapter(connectionId, (adapter) => adapter.listInstruments()),
      this.prisma.symbol.findMany({ where: { enabled: true }, select: { code: true } }),
      this.prisma.brokerInstrumentMapping.findMany({
        where: { connectionId },
        select: { symbolId: true, externalSymbol: true },
      }),
    ]);
    const taken = new Set(existing.map((row) => row.externalSymbol));
    const byNormalised = new Map<string, string>();
    for (const instrument of instruments) {
      if (taken.has(instrument.externalSymbol)) continue;
      const key = normalise(instrument.externalSymbol);
      // First wins: two venue symbols normalising the same way is exactly the
      // ambiguity a person must resolve, so neither is suggested twice.
      if (!byNormalised.has(key)) byNormalised.set(key, instrument.externalSymbol);
    }
    const suggestions: { symbolCode: string; externalSymbol: string }[] = [];
    for (const symbol of symbols) {
      const candidate = byNormalised.get(normalise(symbol.code));
      if (candidate !== undefined) {
        suggestions.push({ symbolCode: symbol.code, externalSymbol: candidate });
      }
    }
    return suggestions;
  }

  /** Map one instrument, copying the venue's own terms for it. */
  async map(
    actorId: string,
    connectionId: string,
    input: { readonly symbolCode: string; readonly externalSymbol: string },
  ): Promise<MappingView> {
    const symbol = await this.prisma.symbol.findFirst({
      where: { code: input.symbolCode.toUpperCase() },
      select: { id: true, code: true },
    });
    if (symbol === null) {
      throw new DomainError(
        TradingErrorCode.UNKNOWN_SYMBOL,
        `${input.symbolCode} is not an instrument this platform trades`,
      );
    }

    const instruments = await this.connections.withAdapter(connectionId, (adapter) =>
      adapter.listInstruments(),
    );
    const venue = instruments.find((row) => row.externalSymbol === input.externalSymbol);
    if (venue === undefined) {
      throw new DomainError(
        TradingErrorCode.UNKNOWN_SYMBOL,
        `This venue does not list ${input.externalSymbol}. Its catalogue is what it will accept.`,
        { externalSymbol: input.externalSymbol },
      );
    }

    const tenantId = requireTenantId();
    const terms = {
      contractSize: venue.contractSize,
      volumeStep: venue.volumeStep,
      minVolume: venue.minVolume,
      maxVolume: venue.maxVolume,
      priceDecimals: venue.priceDecimals,
      syncedAt: new Date(),
    };
    const existing = await this.prisma.brokerInstrumentMapping.findFirst({
      where: { connectionId, symbolId: symbol.id },
      select: { id: true, externalSymbol: true },
    });

    const saved =
      existing === null
        ? await this.prisma.brokerInstrumentMapping.create({
            data: {
              tenantId,
              connectionId,
              symbolId: symbol.id,
              externalSymbol: venue.externalSymbol,
              ...terms,
            },
            include: { symbol: { select: { code: true } } },
          })
        : await this.prisma.brokerInstrumentMapping.update({
            where: { id: existing.id },
            data: { externalSymbol: venue.externalSymbol, ...terms },
            include: { symbol: { select: { code: true } } },
          });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'broker_mapping.set',
      resourceType: 'broker_instrument_mapping',
      resourceId: saved.id,
      ...(existing === null ? {} : { before: { externalSymbol: existing.externalSymbol } }),
      after: {
        connectionId,
        symbol: symbol.code,
        externalSymbol: venue.externalSymbol,
        venueTerms: {
          contractSize: venue.contractSize,
          volumeStep: venue.volumeStep,
          minVolume: venue.minVolume,
          maxVolume: venue.maxVolume,
        },
      },
    });
    return toView(saved);
  }

  async setEnabled(
    actorId: string,
    connectionId: string,
    symbolCode: string,
    enabled: boolean,
  ): Promise<MappingView> {
    const mapping = await this.require(connectionId, symbolCode);
    const updated = await this.prisma.brokerInstrumentMapping.update({
      where: { id: mapping.id },
      data: { enabled },
      include: { symbol: { select: { code: true } } },
    });
    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: enabled ? 'broker_mapping.enabled' : 'broker_mapping.disabled',
      resourceType: 'broker_instrument_mapping',
      resourceId: mapping.id,
      after: { connectionId, symbol: symbolCode, enabled },
    });
    return toView(updated);
  }

  /**
   * Re-read the venue's catalogue into every mapping, and say what moved.
   *
   * Nothing is repaired: a mapping whose venue symbol has disappeared is
   * reported and left, because deciding what a vanished instrument means —
   * renamed, retired, or a bad catalogue read — is not a job for a sweep.
   */
  async sync(actorId: string, connectionId: string): Promise<SyncReport> {
    const instruments = await this.connections.withAdapter(connectionId, (adapter) =>
      adapter.listInstruments(),
    );
    const byExternal = new Map(instruments.map((row) => [row.externalSymbol, row]));
    const mappings = await this.prisma.brokerInstrumentMapping.findMany({
      where: { connectionId },
      include: { symbol: { select: { code: true } } },
    });

    const changed: SyncChange[] = [];
    const missing: string[] = [];
    for (const mapping of mappings) {
      const venue = byExternal.get(mapping.externalSymbol);
      if (venue === undefined) {
        missing.push(mapping.symbol.code);
        continue;
      }
      const differences = termDifferences(mapping, venue);
      await this.prisma.brokerInstrumentMapping.update({
        where: { id: mapping.id },
        data: {
          contractSize: venue.contractSize,
          volumeStep: venue.volumeStep,
          minVolume: venue.minVolume,
          maxVolume: venue.maxVolume,
          priceDecimals: venue.priceDecimals,
          syncedAt: new Date(),
        },
      });
      if (differences.length > 0) {
        changed.push({ symbolCode: mapping.symbol.code, differences });
      }
    }

    if (changed.length > 0 || missing.length > 0) {
      this.logger.warn({ connectionId, changed, missing }, "A venue's instrument terms moved");
      await this.audit.record({
        actorId,
        actorType: 'ADMIN',
        action: 'broker_mapping.synced',
        resourceType: 'broker_connection',
        resourceId: connectionId,
        after: { changed: changed as unknown as Prisma.InputJsonValue, missing },
      });
    }
    return { checked: mappings.length, changed, missing };
  }

  /**
   * What this connection calls the instrument — or a refusal naming what is
   * missing. The order path's only entry point into this service.
   */
  async requireExternalSymbol(connectionId: string, symbolCode: string): Promise<string> {
    const mapping = await this.require(connectionId, symbolCode);
    if (!mapping.enabled) {
      throw new DomainError(
        TradingErrorCode.UNKNOWN_SYMBOL,
        `${symbolCode} is turned off on this venue connection`,
        { symbol: symbolCode },
      );
    }
    return mapping.externalSymbol;
  }

  private async require(connectionId: string, symbolCode: string) {
    const mapping = await this.prisma.brokerInstrumentMapping.findFirst({
      where: { connectionId, symbol: { code: symbolCode.toUpperCase() } },
      include: { symbol: { select: { code: true } } },
    });
    if (mapping === null) {
      throw new DomainError(
        TradingErrorCode.UNKNOWN_SYMBOL,
        `${symbolCode} is not mapped to anything on this venue connection. ` +
          'Map it before trading it there; nothing here guesses a venue’s name for an instrument.',
        { symbol: symbolCode },
      );
    }
    return mapping;
  }
}

export interface SyncChange {
  readonly symbolCode: string;
  readonly differences: readonly string[];
}

export interface SyncReport {
  readonly checked: number;
  readonly changed: readonly SyncChange[];
  /** Mapped instruments the venue no longer lists. Reported, never repaired. */
  readonly missing: readonly string[];
}

function termDifferences(
  mapping: {
    contractSize: Prisma.Decimal | null;
    volumeStep: Prisma.Decimal | null;
    minVolume: Prisma.Decimal | null;
    maxVolume: Prisma.Decimal | null;
    priceDecimals: number | null;
  },
  venue: BrokerInstrument,
): string[] {
  const differences: string[] = [];
  const compare = (name: string, was: Prisma.Decimal | null, now: string) => {
    if (was !== null && was.toString() !== now) differences.push(`${name}: ${was.toString()} → ${now}`);
  };
  compare('contractSize', mapping.contractSize, venue.contractSize);
  compare('volumeStep', mapping.volumeStep, venue.volumeStep);
  compare('minVolume', mapping.minVolume, venue.minVolume);
  compare('maxVolume', mapping.maxVolume, venue.maxVolume);
  if (mapping.priceDecimals !== null && mapping.priceDecimals !== venue.priceDecimals) {
    differences.push(`priceDecimals: ${mapping.priceDecimals} → ${venue.priceDecimals}`);
  }
  return differences;
}

/** Letters and digits only, upper case: `XAU/USD`, `XAUUSD.m` and `xauusd` agree. */
function normalise(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toView(row: {
  id: string;
  symbolId: string;
  externalSymbol: string;
  contractSize: Prisma.Decimal | null;
  volumeStep: Prisma.Decimal | null;
  minVolume: Prisma.Decimal | null;
  maxVolume: Prisma.Decimal | null;
  priceDecimals: number | null;
  enabled: boolean;
  syncedAt: Date | null;
  symbol: { code: string };
}): MappingView {
  return {
    id: row.id,
    symbolId: row.symbolId,
    symbolCode: row.symbol.code,
    externalSymbol: row.externalSymbol,
    contractSize: row.contractSize?.toString() ?? null,
    volumeStep: row.volumeStep?.toString() ?? null,
    minVolume: row.minVolume?.toString() ?? null,
    maxVolume: row.maxVolume?.toString() ?? null,
    priceDecimals: row.priceDecimals,
    enabled: row.enabled,
    syncedAt: row.syncedAt,
  };
}
