import { Injectable } from '@nestjs/common';
import { QuoteService } from '../market/quote.service';
import { PROVIDER_STATUS_KEY, type ProviderStatus } from '../market/provider-status';
import { RedisService } from '../redis/redis.service';
import { SymbolsService } from '../symbols/symbols.service';

export interface MarketDataInstrument {
  readonly symbol: string;
  /** The live source pricing it; `simulator` when none covers it but it has a price; `none` with neither. */
  readonly source: string;
  readonly bid: string | null;
  readonly ask: string | null;
  /** The quote's own time (the source's, for a live feed). */
  readonly quoteAt: number | null;
  readonly ageMs: number | null;
  /** How old a quote may be and still be traded on, for this instrument. */
  readonly maxAgeMs: number;
  readonly stale: boolean;
}

export interface MarketDataView {
  readonly at: number;
  /** When the ingesting instance last published its sources; `null` if it has not, or that is too old. */
  readonly reportedAt: number | null;
  readonly providers: readonly ProviderStatus[];
  readonly instruments: readonly MarketDataInstrument[];
}

/**
 * The Market Data screen: every live source and what it is doing, and every
 * instrument with where its price comes from and how old that price is.
 *
 * Read-only. The sources' state is what the ingesting instance last wrote to
 * Redis; the quotes are the platform's own latest, the same ones the engine
 * would trade on. Nothing here can reveal a key or a URL — the status never
 * held them.
 */
@Injectable()
export class MarketDataAdminService {
  constructor(
    private readonly redis: RedisService,
    private readonly quotes: QuoteService,
    private readonly symbols: SymbolsService,
  ) {}

  async view(now: number = Date.now()): Promise<MarketDataView> {
    const raw = await this.redis.client.get(PROVIDER_STATUS_KEY).catch(() => null);
    let reportedAt: number | null = null;
    let providers: ProviderStatus[] = [];
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { at?: number; providers?: ProviderStatus[] };
        reportedAt = typeof parsed.at === 'number' ? parsed.at : null;
        providers = Array.isArray(parsed.providers) ? parsed.providers : [];
      } catch {
        providers = [];
      }
    }
    const sourceOf = new Map<string, string>();
    for (const provider of providers) {
      for (const symbol of provider.symbols) sourceOf.set(symbol, provider.name);
    }
    const instruments: MarketDataInstrument[] = [];
    for (const symbol of [...this.symbols.codes()].sort()) {
      const tick = await this.quotes.latest(symbol);
      const maxAgeMs = this.quotes.maxAgeMs(symbol);
      const ageMs = tick === null ? null : Math.max(0, now - tick.timestamp);
      instruments.push({
        symbol,
        // No live source and no price at all is `none` — an instrument added
        // and not yet given a source — not `simulator`, which would claim a
        // price that does not exist.
        source: sourceOf.get(symbol) ?? (tick === null ? 'none' : 'simulator'),
        bid: tick?.bid ?? null,
        ask: tick?.ask ?? null,
        quoteAt: tick?.timestamp ?? null,
        ageMs,
        maxAgeMs,
        stale: ageMs === null || ageMs > maxAgeMs,
      });
    }
    return { at: now, reportedAt, providers, instruments };
  }
}
