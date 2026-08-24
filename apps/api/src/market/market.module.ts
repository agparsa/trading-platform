import { Module } from '@nestjs/common';
import { SymbolsService } from '../symbols/symbols.service';
import { SymbolsController } from '../symbols/symbols.controller';
import { MarketController } from './market.controller';
import { MarketFeedService } from './market-feed.service';
import { QuoteService } from './quote.service';
import { CandlesService } from './candles.service';
import { TickBus } from './tick-bus';
import { CandleBus } from './candle-bus';

@Module({
  controllers: [SymbolsController, MarketController],
  providers: [SymbolsService, QuoteService, MarketFeedService, CandlesService, TickBus, CandleBus],
  exports: [SymbolsService, QuoteService, MarketFeedService, CandlesService, TickBus, CandleBus],
})
export class MarketModule {}
