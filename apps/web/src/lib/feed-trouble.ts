import type { MarketProviderRow } from './admin-queries';

export interface FeedTrouble {
  readonly name: string;
  readonly symbols: readonly string[];
  readonly error: string | null;
  readonly since: number;
}

/**
 * The live price sources that are cut off: disconnected, or trying again
 * after an error — a refused key, an exhausted quota, the network. Not a
 * source merely connecting for the first time without having failed, and not
 * one idle over a closed market: both are normal, and a banner that cries
 * every weekend is a banner nobody reads by Tuesday.
 */
export function feedTrouble(providers: readonly MarketProviderRow[]): FeedTrouble[] {
  return providers
    .filter(
      (row) =>
        row.state === 'disconnected' || (row.state !== 'connected' && row.lastError !== null),
    )
    .map((row) => ({
      name: row.name,
      symbols: row.symbols,
      error: row.lastError,
      since: row.since,
    }));
}
