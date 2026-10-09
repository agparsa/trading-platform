/**
 * Which instruments this trader keeps at the top, and how the list is filtered.
 *
 * Per-device like the trading preferences beside them, and for the same reason:
 * these change nothing the server will accept. A favourite is a arrangement of a
 * list, not a permission, and syncing it would be a round trip to move a row.
 *
 * The stored value is treated as untrusted input on the way back in. A corrupted
 * store must produce an empty list, never a crash and never a list of things
 * that are not instrument codes.
 */

const STORAGE_KEY = 'tp:watchlist-favourites';

/** More than this and it is not a shortlist any more. */
const MAX_FAVOURITES = 50;

/** Instrument codes are short and uppercase; anything else did not come from us. */
const CODE = /^[A-Z0-9._-]{1,20}$/;

export function loadFavourites(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  if (storage === undefined) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  try {
    return sanitiseFavourites(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function saveFavourites(
  storage: Pick<Storage, 'setItem'> | undefined,
  favourites: readonly string[],
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitiseFavourites(favourites)));
  } catch {
    // Quota, private mode, a disabled store. The session keeps them in memory
    // and simply does not remember them next time; not worth an error.
  }
}

export function sanitiseFavourites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toUpperCase();
    if (!CODE.test(code)) continue;
    seen.add(code);
    if (seen.size >= MAX_FAVOURITES) break;
  }
  return [...seen];
}

export function toggleFavourite(favourites: readonly string[], code: string): string[] {
  const normalised = code.trim().toUpperCase();
  if (favourites.includes(normalised)) {
    return favourites.filter((entry) => entry !== normalised);
  }
  if (favourites.length >= MAX_FAVOURITES) return [...favourites];
  return [...favourites, normalised];
}

export interface WatchlistItem {
  code: string;
  description: string;
  /**
   * The platform's grouping — "FX", "Metals". Optional because an API older
   * than the field does not send it; such a list simply has no categories.
   */
  category?: string | null;
}

export interface WatchlistView<T extends WatchlistItem> {
  favourites: T[];
  others: T[];
}

/**
 * The list as it should be shown: matching the search, favourites first.
 *
 * Search matches the code *or* the description, because a trader who wants gold
 * may type "gold" rather than "XAU". Within each group the platform's own order
 * is preserved rather than re-sorted — a list that reshuffles as you type is a
 * list you cannot click.
 *
 * `favouritesOnly` is a separate switch from the search term so that clearing
 * the search does not silently abandon the filter. `category` narrows the same
 * way and keeps an instrument only if it is listed under exactly that name;
 * `null` is every category.
 */
export function viewFor<T extends WatchlistItem>(
  items: readonly T[],
  favourites: readonly string[],
  search: string,
  favouritesOnly = false,
  category: string | null = null,
): WatchlistView<T> {
  const needle = search.trim().toUpperCase();
  const starred = new Set(favourites);

  const matching = items.filter((item) => {
    if (favouritesOnly && !starred.has(item.code)) return false;
    if (category !== null && item.category !== category) return false;
    if (needle === '') return true;
    return (
      item.code.toUpperCase().includes(needle) || item.description.toUpperCase().includes(needle)
    );
  });

  return {
    favourites: matching.filter((item) => starred.has(item.code)),
    others: matching.filter((item) => !starred.has(item.code)),
  };
}

/**
 * The categories to offer as filters, in the order the platform lists its
 * instruments — the first instrument of each group places the group. Sorting
 * them alphabetically would put "Crypto" above "FX" on a desk that lists FX
 * first.
 *
 * A list with fewer than two categories offers none: a single "Metals" chip
 * filters nothing.
 */
export function categoriesOf(items: readonly WatchlistItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) {
    const category = item.category?.trim();
    if (category === undefined || category === '' || seen.includes(category)) continue;
    seen.push(category);
  }
  return seen.length < 2 ? [] : seen;
}

/** How many instruments "Top movers" shows. */
export const TOP_MOVERS = 10;

/**
 * The instruments that have moved most since their reference, largest move
 * first, either direction.
 *
 * Only an instrument with a change can be a mover. One with no reference yet
 * (`null`, shown as an em dash) has not moved by zero — it has no number — and
 * one that is exactly unchanged has not moved; neither belongs on the list.
 *
 * The ranking reads the server's change, which refreshes once a minute, not
 * the live tick: a list that reorders on every tick is a list nobody can
 * click. Ties keep the platform's order.
 */
export function topMovers<T extends WatchlistItem>(
  items: readonly T[],
  changes: Readonly<Record<string, { changePercent: string | null } | undefined>>,
  limit = TOP_MOVERS,
): T[] {
  const ranked: Array<{ item: T; size: number; at: number }> = [];
  items.forEach((item, at) => {
    const raw = changes[item.code]?.changePercent ?? null;
    if (raw === null) return;
    const size = Math.abs(Number(raw));
    if (!Number.isFinite(size) || size === 0) return;
    ranked.push({ item, size, at });
  });
  ranked.sort((a, b) => b.size - a.size || a.at - b.at);
  return ranked.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}
