import type { MarketStatusDto } from '@tp/shared-types';

/**
 * One short phrase for a market that is not open (§36).
 *
 * The list row has space for a few words after the instrument's name, so this
 * is deliberately shorter than the web's notice — and it keeps the same rule:
 * a state the platform has no opening time for never gets one invented. "market
 * closed" said the same thing for a halt, a weekend and an instrument nobody
 * had configured; these tell them apart.
 */
export function marketLabel(market: MarketStatusDto): string {
  switch (market.state) {
    case 'OPEN':
      return 'open';
    case 'HALTED':
      return 'trading halted';
    case 'UNKNOWN':
      return 'no trading session';
    case 'PRE_OPEN':
      return market.opensAt === null ? 'not open yet' : `opens ${inWords(market.opensAt)}`;
    default:
      return market.opensAt === null
        ? 'market closed'
        : `closed · opens ${inWords(market.opensAt)}`;
  }
}

function inWords(opensAt: number, nowMs: number = Date.now()): string {
  const minutes = Math.round((opensAt - nowMs) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h`;
  return new Date(opensAt).toLocaleDateString(undefined, { weekday: 'long' });
}
