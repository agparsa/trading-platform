import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  LOCALE_BOOT_SCRIPT,
  LOCALE_STORAGE_KEY,
  applyLocale,
  directionOf,
  loadLocale,
} from './locale';
import { en, fa, placeholdersOf, translate, type MessageKey } from './messages';

/** Runs the boot script against a stored value and returns what it set on <html>. */
function boot(stored: string | null, throws = false) {
  const root = { lang: '', dir: '' };
  runInNewContext(LOCALE_BOOT_SCRIPT, {
    localStorage: {
      getItem: (key: string) => {
        if (throws) throw new Error('blocked');
        return key === LOCALE_STORAGE_KEY ? stored : null;
      },
    },
    document: { documentElement: root },
  });
  return root;
}

describe('the interface language', () => {
  it('is set before the first paint exactly as the bundle would set it', () => {
    for (const stored of ['fa', 'en', null, 'de', '<script>', ''] as const) {
      const fromScript = boot(stored);
      const locale = loadLocale({ getItem: () => stored });
      const fromBundle = { lang: '', dir: '' };
      applyLocale(fromBundle as unknown as HTMLElement, locale);
      expect(fromScript, String(stored)).toEqual(fromBundle);
    }
    expect(boot('fa')).toEqual({ lang: 'fa', dir: 'rtl' });
    expect(boot(null)).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('leaves the page as the server sent it when storage cannot be read', () => {
    expect(boot('fa', true)).toEqual({ lang: '', dir: '' });
    expect(
      loadLocale({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('en');
  });

  it('lays Persian out right to left', () => {
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });
});

describe('the message tables', () => {
  const keys = Object.keys(en) as MessageKey[];

  it('translate every English key into Persian, and nothing else', () => {
    expect(Object.keys(fa).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(fa[key].trim(), key).not.toBe('');
  });

  it('keep the same placeholders in both languages', () => {
    const differ = keys.filter(
      (key) => placeholdersOf(en[key]).join() !== placeholdersOf(fa[key]).join(),
    );
    expect(differ).toEqual([]);
  });

  it('give each language its own words', () => {
    expect(translate('fa', 'nav.terminal')).toBe('ترمینال');
    expect(translate('en', 'nav.terminal')).toBe('Terminal');
  });

  it('keep a filled figure left to right inside Persian, and leave English alone', () => {
    const vars = { minimum: '$10.00', maximum: '$50,000.00' };
    expect(translate('fa', 'wallet.withdraw.range', vars)).toBe(
      'هر درخواست بین \u2066$10.00\u2069 و \u2066$50,000.00\u2069',
    );
    expect(translate('en', 'wallet.withdraw.range', vars)).toBe(
      'Between $10.00 and $50,000.00 per request',
    );
    // An accessible name compared with the visible figure asks for it bare.
    expect(translate('fa', 'wl.buyAt', { code: 'XAUUSD', price: '4582.72' }, false)).toBe(
      'خرید XAUUSD با 4582.72',
    );
  });

  it('do not translate a figure: Persian copy carries no Persian digits', () => {
    const persianDigits = keys.filter((key) => /[۰-۹٠-٩]/.test(fa[key]));
    expect(persianDigits).toEqual([]);
  });
});
