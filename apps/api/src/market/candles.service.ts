import { Injectable } from '@nestjs/common';
import { toDecimal } from '@tp/financial-core';
import { Resolution, type Candle } from '@tp/market-core';
import { PrismaService } from '../prisma/prisma.service';
import { MarketFeedService } from './market-feed.service';
import { QuoteService } from './quote.service';

/** Chart requests are bounded so one client cannot ask for a decade of minutes. */
const MAX_BARS = 5_000;

@Injectable()
export class CandlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: MarketFeedService,
    private readonly quotes: QuoteService,
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

  /**
   * Today's bar and the change from the previous one, per instrument.
   *
   * Two daily bars per symbol, which is two rows — the whole point of asking the
   * database rather than replaying minutes. The in-progress bar comes from the
   * aggregator for the same reason the chart's does: without it the day's high
   * would lag by up to a full day.
   *
   * `last` is the mid of the current quote, not the daily bar's close. The bar
   * closes on the bid; a watchlist quoting a change against the bid while
   * showing bid and ask beside it invites the reading that the change is
   * one-sided. The mid is the neutral figure, and it is named as the reference
   * so nobody has to guess.
   */
  async dailyStats(symbols: readonly string[]): Promise<DailyStats[]> {
    const stats: DailyStats[] = [];

    for (const symbol of symbols) {
      const rows = await this.prisma.candle.findMany({
        where: { symbolCode: symbol, resolution: Resolution.D1 },
        orderBy: { time: 'desc' },
        take: 2,
      });

      const live = this.feed.currentCandle(symbol, Resolution.D1);
      const today =
        live !== null
          ? live
          : rows[0] === undefined
            ? null
            : {
                open: rows[0].open.toString(),
                high: rows[0].high.toString(),
                low: rows[0].low.toString(),
                time: rows[0].time.getTime(),
              };

      // The previous bar is whichever stored row is not today's.
      const previous = rows.find((row) => today === null || row.time.getTime() !== today.time);

      const tick = await this.quotes.latest(symbol);
      const last =
        tick === null ? null : toDecimal(tick.bid).plus(toDecimal(tick.ask)).div(2).toString();

      const referenceKind: DailyStats['referenceKind'] =
        previous !== undefined ? 'PREVIOUS_CLOSE' : today !== null ? 'SESSION_OPEN' : 'NONE';
      const reference = previous !== undefined ? previous.close.toString() : (today?.open ?? null);

      let change: string | null = null;
      let changePercent: string | null = null;
      if (last !== null && reference !== null) {
        const from = toDecimal(reference);
        change = toDecimal(last).minus(from).toString();
        // A reference of zero is not a market; dividing by it would print
        // Infinity where the honest answer is "unknown".
        if (from.gt(0)) {
          changePercent = toDecimal(change).div(from).times(100).toFixed(4);
        }
      }

      stats.push({
        symbol,
        open: today?.open ?? null,
        high: today?.high ?? null,
        low: today?.low ?? null,
        last,
        reference,
        referenceKind,
        change,
        changePercent,
      });
    }

    return stats;
  }
}

/**
 * How an instrument has moved today, as the server sees it.
 *
 * The watchlist needs a change figure, and the browser must not be the one that
 * computes it. Two reasons, and the second is the one that matters:
 *
 *  1. A client subtracting a remembered price from a live one produces a number
 *     that depends on when that client happened to connect. Two traders would
 *     see different changes for the same instrument at the same moment.
 *  2. It could not say *what it was measured against*. "+0.42%" is not a fact
 *     until the reference is named, and this names it.
 *
 * The reference is the previous daily bar's close where one exists, and today's
 * open otherwise — a newly-listed instrument, or a platform whose history starts
 * this morning, has no previous close and must not pretend to.
 */
export interface DailyStats {
  symbol: string;
  /** Open of the current daily bar. */
  open: string | null;
  high: string | null;
  low: string | null;
  /** The price the change is measured *to*: the current mid. */
  last: string | null;
  /** The price the change is measured *from*. */
  reference: string | null;
  referenceKind: 'PREVIOUS_CLOSE' | 'SESSION_OPEN' | 'NONE';
  /** `last - reference`, in the instrument's quote currency. Null when unknown. */
  change: string | null;
  /** The same as a percentage of the reference. Null when unknown. */
  changePercent: string | null;
}
