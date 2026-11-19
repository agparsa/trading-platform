import type { MarketStatusDto } from '@tp/shared-types';
import { english, type Translate } from './messages';

/**
 * One short phrase for a market that is not open (§36).
 *
 * The list row has space for a few words after the instrument's name, so this
 * is deliberately shorter than the web's notice — and it keeps the same rule:
 * a state the platform has no opening time for never gets one invented. "market
 * closed" said the same thing for a halt, a weekend and an instrument nobody
 * had configured; these tell them apart.
 */
export function marketLabel(market: MarketStatusDto, t: Translate = english): string {
  switch (market.state) {
    case 'OPEN':
      return t('market.open');
    case 'HALTED':
      return t('market.halted');
    case 'UNKNOWN':
      return t('market.noSession');
    case 'PRE_OPEN':
      return market.opensAt === null
        ? t('market.notOpenYet')
        : t('market.opens', { when: inWords(market.opensAt, t) });
    default:
      return market.opensAt === null
        ? t('market.closed')
        : t('market.closedOpens', { when: inWords(market.opensAt, t) });
  }
}

function inWords(opensAt: number, t: Translate, nowMs: number = Date.now()): string {
  const minutes = Math.round((opensAt - nowMs) / 60_000);
  if (minutes <= 0) return t('market.now');
  if (minutes < 60) return t('market.inMinutes', { n: minutes });
  if (minutes < 24 * 60) return t('market.inHours', { n: Math.floor(minutes / 60) });
  return new Date(opensAt).toLocaleDateString(undefined, { weekday: 'long' });
}
