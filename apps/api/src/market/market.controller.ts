import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isResolution, type Resolution } from '@tp/market-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from './quote.service';
import { CandlesService } from './candles.service';

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
  ) {}

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
    if (!isResolution(query.resolution)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Unsupported resolution '${query.resolution}'`,
        { resolution: query.resolution },
      );
    }
    return this.candles.range(symbol, query.resolution as Resolution, query.from, query.to);
  }
}
