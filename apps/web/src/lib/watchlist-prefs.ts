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
 * the search does not silently abandon the filter.
 */
export function viewFor<T extends WatchlistItem>(
  items: readonly T[],
  favourites: readonly string[],
  search: string,
  favouritesOnly = false,
): WatchlistView<T> {
  const needle = search.trim().toUpperCase();
  const starred = new Set(favourites);

  const matching = items.filter((item) => {
    if (favouritesOnly && !starred.has(item.code)) return false;
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
