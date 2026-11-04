/**
 * The interface language, chosen per browser: English or Persian.
 *
 * Kept beside the theme for the theme's reason — it is how this browser shows
 * the platform, not a fact about the account — and set on `<html>` before the
 * first paint by `LOCALE_BOOT_SCRIPT`, so a Persian reader never sees the page
 * lay itself out left-to-right and then flip.
 *
 * Persian is written right to left; numbers inside it are not. Every changing
 * figure carries the `numeric` class, and `globals.css` keeps those
 * left-to-right in a right-to-left page, so `-1,204.50` is never mirrored into
 * something that is not a number. Figures stay in Latin digits: a price is
 * compared against charts, statements and other platforms that print them so.
 *
 * The stored value is untrusted on the way back: anything that is not a known
 * locale is English.
 */
export type Locale = 'en' | 'fa';

export const LOCALE_STORAGE_KEY = 'tp:locale';
export const LOCALES: readonly Locale[] = ['en', 'fa'];

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'fa';
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

export function loadLocale(storage: Pick<Storage, 'getItem'> | undefined): Locale {
  if (storage === undefined) return 'en';
  try {
    const raw = storage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(raw) ? raw : 'en';
  } catch {
    return 'en';
  }
}

export function saveLocale(storage: Pick<Storage, 'setItem'> | undefined, locale: Locale): void {
  if (storage === undefined) return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode, a full quota: this session keeps the choice; the next does not.
  }
}

/** Puts a locale on the page: the attributes the stylesheet and screen readers read. */
export function applyLocale(root: HTMLElement, locale: Locale): void {
  root.lang = locale;
  root.dir = directionOf(locale);
}

/**
 * The same rule as `loadLocale` + `applyLocale`, in the only form that runs
 * before the bundle. `locale.test.ts` runs it against every stored value.
 */
export const LOCALE_BOOT_SCRIPT = `(function(){try{var l=localStorage.getItem('${LOCALE_STORAGE_KEY}');l=l==='fa'?'fa':'en';var e=document.documentElement;e.lang=l;e.dir=l==='fa'?'rtl':'ltr';}catch(x){}})();`;
