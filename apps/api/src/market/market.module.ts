import { Module } from '@nestjs/common';
import { SymbolsService } from '../symbols/symbols.service';
import { SymbolsController } from '../symbols/symbols.controller';
import { MarketController } from './market.controller';
import { MarketFeedService } from './market-feed.service';
import { QuoteService } from './quote.service';
import { CandlesService } from './candles.service';

@Module({
  controllers: [SymbolsController, MarketController],
  providers: [SymbolsService, QuoteService, MarketFeedService, CandlesService],
  exports: [SymbolsService, QuoteService, MarketFeedService, CandlesService],
})
export class MarketModule {}
