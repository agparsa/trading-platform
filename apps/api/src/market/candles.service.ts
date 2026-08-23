import { Injectable } from '@nestjs/common';
import type { Candle, Resolution } from '@tp/market-core';
import { PrismaService } from '../prisma/prisma.service';
import { MarketFeedService } from './market-feed.service';

/** Chart requests are bounded so one client cannot ask for a decade of minutes. */
const MAX_BARS = 5_000;

@Injectable()
export class CandlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: MarketFeedService,
  ) {}

  /**
   * Closed candles from the database, plus the in-progress one from the
   * aggregator.
   *
   * The live bar is served separately because it has not been persisted yet —
   * without it the chart's rightmost candle would lag by up to a full
   * resolution, which looks like a frozen feed.
   */
  async range(
    symbol: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<Candle[]> {
    const rows = await this.prisma.candle.findMany({
      where: {
        symbolCode: symbol,
        resolution,
        time: { gte: new Date(fromMs), lte: new Date(toMs) },
      },
      orderBy: { time: 'asc' },
      take: MAX_BARS,
    });

    const candles: Candle[] = rows.map((row) => ({
      symbol: row.symbolCode,
      resolution: row.resolution as Resolution,
      time: row.time.getTime(),
      open: row.open.toString(),
      high: row.high.toString(),
      low: row.low.toString(),
      close: row.close.toString(),
      volume: row.volume.toString(),
    }));

    const live = this.feed.currentCandle(symbol, resolution);
    if (live !== null && live.time >= fromMs && live.time <= toMs) {
      const last = candles[candles.length - 1];
      if (last !== undefined && last.time === live.time) candles[candles.length - 1] = live;
      else candles.push(live);
    }

    return candles;
  }
}
