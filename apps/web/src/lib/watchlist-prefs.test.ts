import { describe, expect, it } from 'vitest';
import {
  loadFavourites,
  sanitiseFavourites,
  saveFavourites,
  toggleFavourite,
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
