import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RESOLUTIONS, isResolution, type Resolution } from '@tp/market-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from './quote.service';
import { CandlesService } from './candles.service';
import { MarketFeedService } from './market-feed.service';

const quotesQuerySchema = z
  .object({
    // Comma-separated, or omitted for everything the platform quotes.
    symbols: z.string().max(500).optional(),
  })
  .strict();

const candlesQuerySchema = z
  .object({
    symbol: z.string().min(1).max(20),
    resolution: z.string().min(1).max(4),
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.to > value.from, { message: '`to` must be after `from`' });

class QuotesQueryDto extends createZodDto(quotesQuerySchema) {}
class CandlesQueryDto extends createZodDto(candlesQuerySchema) {}

@ApiTags('market')
@Controller('market')
export class MarketController {
  constructor(
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
    private readonly candles: CandlesService,
    private readonly feed: MarketFeedService,
  ) {}

  /**
   * Which resolutions this deployment serves. The clients build their row of
   * timeframe buttons from this rather than from a copy of the platform's
   * vocabulary: a button for a resolution nobody aggregates opens an empty
   * chart, and the copy was six entries long while the vocabulary was seven.
   */
  @Get('resolutions')
  @ApiOperation({ summary: 'The candle resolutions this deployment aggregates, shortest first' })
  resolutions(): { resolutions: readonly Resolution[] } {
    return { resolutions: this.feed.servedResolutions() };
  }

  @Get('quotes')
  @ApiOperation({ summary: 'Latest bid/ask for one or more instruments' })
  async quotes_(@Query() query: QuotesQueryDto) {
    const requested =
      query.symbols === undefined
        ? this.symbols.codes()
        : query.symbols.split(',').map((code) => code.trim().toUpperCase());
    // Validate every code, so a typo is an error rather than a silent omission.
    for (const code of requested) this.symbols.require(code);
    return this.quotes.snapshot(requested);
  }

  /**
   * How each instrument has moved today.
   *
   * Computed on the server so every trader sees the same number measured
   * against the same reference — and so the reference is *named*, which a
   * change figure computed in a browser from whenever it happened to connect
   * cannot do.
   */
  @Get('stats')
  @ApiOperation({ summary: "Today's open, high, low and change for one or more instruments" })
  async stats(@Query() query: QuotesQueryDto) {
    const requested =
      query.symbols === undefined
        ? this.symbols.codes()
        : query.symbols.split(',').map((code) => code.trim().toUpperCase());
    for (const code of requested) this.symbols.require(code);
    return this.candles.dailyStats(requested);
  }

  @Get('candles')
  @ApiOperation({ summary: 'Historical candles, including the in-progress bar' })
  async candlesFor(@Query() query: CandlesQueryDto) {
    const symbol = query.symbol.toUpperCase();
    this.symbols.require(symbol);
    const resolution = servedResolution(query.resolution, this.feed.servedResolutions());
    return this.candles.range(symbol, resolution, query.from, query.to);
  }
}

/**
 * The resolution a candles request may ask for: one the platform knows *and*
 * this deployment serves. Two refusals, told apart on purpose — a typo and a
 * setting are different conversations — and both name what would be accepted.
 */
export function servedResolution(requested: string, served: readonly Resolution[]): Resolution {
  if (!isResolution(requested)) {
    throw new DomainError(
      TradingErrorCode.VALIDATION_FAILED,
      `Unsupported resolution '${requested}'`,
      { resolution: requested, known: [...RESOLUTIONS] },
    );
  }
  if (!served.includes(requested)) {
    throw new DomainError(
      TradingErrorCode.VALIDATION_FAILED,
      `Resolution '${requested}' is not aggregated on this deployment`,
      { resolution: requested, served: [...served] },
    );
  }
  return requested;
}
