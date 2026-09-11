import type { MarketState, MarketStatusDto } from '@tp/shared-types';

/**
 * What to put on the screen when a market is not open (§36).
 *
 * The platform used to know only `sessionOpen`, so every shut instrument got
 * the same word — "closed" — whether it opened in ten minutes, on Sunday
 * evening, or never because nobody had configured it. A trader at a weekend saw
 * a dead chart and had to guess.
 *
 * Two rules hold the wording honest:
 *
 * - **Never invent a time.** `opensAt` is null for a halt (indefinite, by
 *   decision) and for an instrument with no session. Those say why they are
 *   shut and stop there, rather than offering a countdown to nothing.
 * - **Say the distance, not the timestamp**, while it is close enough to be a
 *   wait — "opens in 12m" is what someone sitting at the screen is asking. Past
 *   a day it becomes a weekday and a clock time, because "opens in 58h" is not
 *   a thing anybody reads.
 */
export interface MarketNotice {
  /** A word for a badge: lowercase, short. */
  readonly label: string;
  /** A sentence for a panel, or null when the state needs no explaining. */
  readonly detail: string | null;
}

const LABELS: Record<MarketState, string> = {
  OPEN: 'open',
  PRE_OPEN: 'pre-open',
  POST_CLOSE: 'post-close',
  CLOSED: 'closed',
  HALTED: 'halted',
  UNKNOWN: 'no session',
};

export function marketNotice(
  market: MarketStatusDto,
  code: string,
  nowMs: number = Date.now(),
): MarketNotice {
  const label = LABELS[market.state];
  if (market.state === 'OPEN') return { label, detail: null };

  if (market.state === 'HALTED') {
    return {
      label,
      detail: `Trading is halted. ${code} cannot be opened; existing positions can still be closed.`,
    };
  }
  if (market.state === 'UNKNOWN') {
    return {
      label,
      detail: `${code} has no trading session configured, so the platform cannot say when it trades.`,
    };
  }

  const opens = market.opensAt === null ? null : untilOpen(market.opensAt, nowMs);
  const why =
    market.state === 'PRE_OPEN'
      ? `${code} has not opened yet.`
      : `${code} is outside its trading session.`;
  return {
    label,
    detail: opens === null ? `${why} No opening time is scheduled.` : `${why} ${opens}`,
  };
}

/** "Opens in 12m", "Opens in 3h 20m", or "Opens Sunday 22:00". */
function untilOpen(opensAt: number, nowMs: number): string {
  const minutes = Math.round((opensAt - nowMs) / 60_000);
  // A countdown that has run out says so rather than counting backwards: the
  // next poll will have the open, and "opens in -1m" reads like a fault.
  if (minutes <= 0) return 'Opening now.';
  if (minutes < 60) return `Opens in ${minutes}m.`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `Opens in ${hours}h${rest === 0 ? '' : ` ${rest}m`}.`;
  }
  const when = new Date(opensAt);
  const weekday = when.toLocaleDateString(undefined, { weekday: 'long' });
  const clock = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Opens ${weekday} at ${clock}.`;
}
