import { describe, expect, it } from 'vitest';
import {
  TOP_MOVERS,
  categoriesOf,
  loadFavourites,
  sanitiseFavourites,
  saveFavourites,
  toggleFavourite,
  topMovers,
  viewFor,
} from './watchlist-prefs';

const item = (code: string, description: string) => ({ code, description });

const INSTRUMENTS = [
  item('XAUUSD', 'Gold vs US Dollar'),
  item('EURUSD', 'Euro vs US Dollar'),
  item('BTCUSD', 'Bitcoin vs US Dollar'),
  item('USDJPY', 'US Dollar vs Japanese Yen'),
];

describe('sanitiseFavourites', () => {
  it('keeps well-formed codes and normalises their case', () => {
    expect(sanitiseFavourites(['xauusd', 'EURUSD'])).toEqual(['XAUUSD', 'EURUSD']);
  });

  /** A corrupted store must produce an empty list, not a crash. */
  it('refuses anything that is not a list of codes', () => {
    expect(sanitiseFavourites(null)).toEqual([]);
    expect(sanitiseFavourites('XAUUSD')).toEqual([]);
    expect(sanitiseFavourites([{ code: 'XAUUSD' }, 42, null])).toEqual([]);
    expect(sanitiseFavourites(['<script>alert(1)</script>'])).toEqual([]);
    expect(sanitiseFavourites(['X'.repeat(50)])).toEqual([]);
  });

  it('drops duplicates', () => {
    expect(sanitiseFavourites(['XAUUSD', 'xauusd'])).toEqual(['XAUUSD']);
  });

  it('bounds the list', () => {
    const many = Array.from({ length: 200 }, (_, i) => `SYM${i}`);
    expect(sanitiseFavourites(many).length).toBeLessThanOrEqual(50);
  });
});

describe('toggleFavourite', () => {
  it('adds and removes', () => {
    expect(toggleFavourite([], 'XAUUSD')).toEqual(['XAUUSD']);
    expect(toggleFavourite(['XAUUSD'], 'XAUUSD')).toEqual([]);
  });

  it('normalises what it is given', () => {
    expect(toggleFavourite([], ' xauusd ')).toEqual(['XAUUSD']);
    expect(toggleFavourite(['XAUUSD'], 'xauusd')).toEqual([]);
  });

  it('refuses to grow past the bound', () => {
    const full = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
    expect(toggleFavourite(full, 'XAUUSD')).toHaveLength(50);
  });
});

describe('viewFor', () => {
  it('puts favourites first and keeps the platform order within each group', () => {
    const view = viewFor(INSTRUMENTS, ['BTCUSD', 'EURUSD'], '');
    expect(view.favourites.map((i) => i.code)).toEqual(['EURUSD', 'BTCUSD']);
    expect(view.others.map((i) => i.code)).toEqual(['XAUUSD', 'USDJPY']);
  });

  it('matches on the code', () => {
    const view = viewFor(INSTRUMENTS, [], 'usd');
    expect(view.others.map((i) => i.code)).toEqual(['XAUUSD', 'EURUSD', 'BTCUSD', 'USDJPY']);
  });

  /** A trader who wants gold types "gold", not "XAU". */
  it('matches on the description too', () => {
    const view = viewFor(INSTRUMENTS, [], 'gold');
    expect(view.others.map((i) => i.code)).toEqual(['XAUUSD']);
  });

  it('is case-insensitive and ignores surrounding space', () => {
    expect(viewFor(INSTRUMENTS, [], '  BiTcOiN  ').others.map((i) => i.code)).toEqual(['BTCUSD']);
  });

  it('can show only favourites, independently of the search box', () => {
    const view = viewFor(INSTRUMENTS, ['BTCUSD'], '', true);
    expect(view.favourites.map((i) => i.code)).toEqual(['BTCUSD']);
    expect(view.others).toEqual([]);
  });

  it('combines the two filters', () => {
    const view = viewFor(INSTRUMENTS, ['BTCUSD', 'EURUSD'], 'euro', true);
    expect(view.favourites.map((i) => i.code)).toEqual(['EURUSD']);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    const view = viewFor(INSTRUMENTS, [], 'platinum');
    expect(view.favourites).toEqual([]);
    expect(view.others).toEqual([]);
  });
});

const listed = (code: string, category: string | null | undefined) => ({
  code,
  description: code,
  category,
});

const GROUPED = [
  listed('EURUSD', 'FX'),
  listed('XAUUSD', 'Metals'),
  listed('GBPUSD', 'FX'),
  listed('BTCUSD', 'Crypto'),
  listed('XAGUSD', 'Metals'),
];

describe('categories', () => {
  it('offers each category once, in the order the platform lists them', () => {
    expect(categoriesOf(GROUPED)).toEqual(['FX', 'Metals', 'Crypto']);
  });

  /** One chip filters nothing; an older API sends no category at all. */
  it('offers none when there is nothing to choose between', () => {
    expect(categoriesOf([listed('EURUSD', 'FX'), listed('GBPUSD', 'FX')])).toEqual([]);
    expect(categoriesOf(INSTRUMENTS)).toEqual([]);
    expect(categoriesOf([listed('A', null), listed('B', '  '), listed('C', 'FX')])).toEqual([]);
  });

  it('narrows the list to one category, favourites still first', () => {
    const view = viewFor(GROUPED, ['XAGUSD'], '', false, 'Metals');
    expect(view.favourites.map((i) => i.code)).toEqual(['XAGUSD']);
    expect(view.others.map((i) => i.code)).toEqual(['XAUUSD']);
  });

  it('combines with the search and the favourites switch', () => {
    expect(viewFor(GROUPED, [], 'gbp', false, 'FX').others.map((i) => i.code)).toEqual(['GBPUSD']);
    expect(viewFor(GROUPED, [], 'gbp', false, 'Metals').others).toEqual([]);
    expect(viewFor(GROUPED, ['EURUSD'], '', true, 'Metals').favourites).toEqual([]);
  });

  it('is every category when none is chosen', () => {
    expect(viewFor(GROUPED, [], '', false, null).others).toHaveLength(GROUPED.length);
  });
});

describe('topMovers', () => {
  const change = (changePercent: string | null) => ({ changePercent });

  it('ranks by the size of the move, either direction', () => {
    const ranked = topMovers(GROUPED, {
      EURUSD: change('0.12'),
      XAUUSD: change('-1.80'),
      GBPUSD: change('0.40'),
      BTCUSD: change('3.05'),
      XAGUSD: change('-0.41'),
    });
    expect(ranked.map((i) => i.code)).toEqual(['BTCUSD', 'XAUUSD', 'XAGUSD', 'GBPUSD', 'EURUSD']);
  });

  /**
   * An em dash is not a zero: no reference means no number, and an instrument
   * without a number has not moved. Exactly unchanged has not moved either.
   */
  it('leaves out an instrument with no change, or none at all', () => {
    const ranked = topMovers(GROUPED, {
      EURUSD: change(null),
      XAUUSD: change('0.00'),
      BTCUSD: change('1.10'),
      XAGUSD: change('not a number'),
    });
    expect(ranked.map((i) => i.code)).toEqual(['BTCUSD']);
  });

  it('keeps the platform order on a tie, so equal moves do not swap places', () => {
    const ranked = topMovers(GROUPED, {
      EURUSD: change('0.50'),
      GBPUSD: change('-0.50'),
      XAUUSD: change('0.50'),
    });
    expect(ranked.map((i) => i.code)).toEqual(['EURUSD', 'XAUUSD', 'GBPUSD']);
  });

  it('shows at most the top few', () => {
    const many = Array.from({ length: 25 }, (_, i) => listed(`SYM${i}`, 'FX'));
    const changes = Object.fromEntries(many.map((item, i) => [item.code, change(`${i + 1}`)]));
    const ranked = topMovers(many, changes);
    expect(ranked).toHaveLength(TOP_MOVERS);
    expect(ranked[0]!.code).toBe('SYM24');
    expect(topMovers(many, changes, 3).map((i) => i.code)).toEqual(['SYM24', 'SYM23', 'SYM22']);
  });

  it('is empty, not an error, before the changes have loaded', () => {
    expect(topMovers(GROUPED, {})).toEqual([]);
  });
});

describe('storage', () => {
  it('round-trips through a store', () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    saveFavourites(storage, ['XAUUSD', 'btcusd']);
    expect(loadFavourites(storage)).toEqual(['XAUUSD', 'BTCUSD']);
  });

  it('survives a store that throws', () => {
    const angry = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadFavourites(angry)).toEqual([]);
    expect(() => saveFavourites(angry, ['XAUUSD'])).not.toThrow();
  });

  it('survives a store holding something that is not JSON', () => {
    const storage = { getItem: () => 'not json at all' };
    expect(loadFavourites(storage)).toEqual([]);
  });

  it('does nothing at all when there is no store, as on the server', () => {
    expect(loadFavourites(undefined)).toEqual([]);
    expect(() => saveFavourites(undefined, ['XAUUSD'])).not.toThrow();
  });
});
