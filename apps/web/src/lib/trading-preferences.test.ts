import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYS,
  DEFAULT_PREFERENCES,
  loadPreferences,
  sanitise,
  savePreferences,
} from './trading-preferences';

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    read: (key: string) => data.get(key) ?? null,
  };
}

const KEY = 'tp:trading-preferences';

describe('defaults', () => {
  /**
   * A terminal that arrives already able to send an order on a single keystroke
   * has made a decision about somebody's money that they did not make.
   */
  it('arrives disarmed', () => {
    expect(DEFAULT_PREFERENCES.oneClick).toBe(false);
    expect(DEFAULT_PREFERENCES.keyboard).toBe(false);
    expect(DEFAULT_PREFERENCES.confirm).toBe(true);
  });
});

describe('loadPreferences', () => {
  it('returns the defaults with nothing stored', () => {
    expect(loadPreferences(store())).toEqual(DEFAULT_PREFERENCES);
    expect(loadPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips what was saved', () => {
    const storage = store();
    const wanted = {
      ...DEFAULT_PREFERENCES,
      oneClick: true,
      confirm: false,
      defaultVolume: '0.25',
      defaultStopLoss: '4500.00',
      keyboard: true,
      keys: { ...DEFAULT_KEYS, buy: 'q' },
    };
    savePreferences(storage, wanted);
    expect(loadPreferences(storage)).toEqual(wanted);
  });

  /**
   * The direction of forgiveness is the whole point. Unreadable input becomes
   * the *safe* value: a corrupted store must not be able to arm one-click
   * trading or switch off a confirmation.
   */
  it('never arms anything from a value it cannot read', () => {
    for (const raw of [
      'not json',
      '[]',
      'null',
      '"true"',
      '{"oneClick":"yes"}',
      '{"oneClick":1}',
    ]) {
      const loaded = loadPreferences(store({ [KEY]: raw }));
      expect(loaded.oneClick).toBe(false);
      expect(loaded.keyboard).toBe(false);
      expect(loaded.confirm).toBe(true);
    }
  });

  /**
   * Confirmation is asymmetric with the rest: it stays on unless something
   * explicitly says `false`. A partial or half-written object leaves the safer
   * behaviour standing.
   */
  it('keeps confirmation on unless it was explicitly switched off', () => {
    expect(loadPreferences(store({ [KEY]: '{}' })).confirm).toBe(true);
    expect(loadPreferences(store({ [KEY]: '{"confirm":"no"}' })).confirm).toBe(true);
    expect(loadPreferences(store({ [KEY]: '{"confirm":0}' })).confirm).toBe(true);
    expect(loadPreferences(store({ [KEY]: '{"confirm":false}' })).confirm).toBe(false);
  });

  it('falls back on a volume that is not a number, and keeps an empty level', () => {
    expect(loadPreferences(store({ [KEY]: '{"defaultVolume":"lots"}' })).defaultVolume).toBe(
      '0.10',
    );
    expect(loadPreferences(store({ [KEY]: '{"defaultVolume":"0.5"}' })).defaultVolume).toBe('0.5');
    // Empty is a real choice — "no default stop" — not a malformed one.
    expect(loadPreferences(store({ [KEY]: '{"defaultStopLoss":"  "}' })).defaultStopLoss).toBe('');
    expect(loadPreferences(store({ [KEY]: '{"defaultStopLoss":"nope"}' })).defaultStopLoss).toBe(
      '',
    );
  });

  it('replaces a key that is not a single character', () => {
    const loaded = loadPreferences(
      store({ [KEY]: '{"keys":{"buy":"","sell":"sell","close":"x"}}' }),
    );
    expect(loaded.keys.buy).toBe(DEFAULT_KEYS.buy);
    expect(loaded.keys.sell).toBe(DEFAULT_KEYS.sell);
    expect(loaded.keys.close).toBe('x');
    expect(loaded.keys.closeAll).toBe(DEFAULT_KEYS.closeAll);
  });

  /** A browser with storage switched off is a browser that trades with defaults. */
  it('survives a storage that throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(loadPreferences(hostile)).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('savePreferences', () => {
  it('writes a sanitised copy, not whatever it was handed', () => {
    const storage = store();
    savePreferences(storage, {
      ...DEFAULT_PREFERENCES,
      oneClick: 'yes' as unknown as boolean,
      defaultVolume: 'lots',
    });
    const written = JSON.parse(storage.read(KEY) ?? '{}') as Record<string, unknown>;
    expect(written['oneClick']).toBe(false);
    expect(written['defaultVolume']).toBe('0.10');
  });

  it('does not throw when the store refuses', () => {
    const full = {
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => savePreferences(full, DEFAULT_PREFERENCES)).not.toThrow();
    expect(() => savePreferences(undefined, DEFAULT_PREFERENCES)).not.toThrow();
  });
});

describe('sanitise', () => {
  it('turns anything unrecognisable into the defaults', () => {
    for (const value of [null, undefined, 42, 'text', true]) {
      expect(sanitise(value)).toEqual(DEFAULT_PREFERENCES);
    }
  });
});
