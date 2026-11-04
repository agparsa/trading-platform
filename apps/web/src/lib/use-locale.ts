'use client';

import { useCallback, useEffect, useState } from 'react';
import { applyLocale, loadLocale, saveLocale, type Locale } from './locale';
import { translate, type MessageKey } from './messages';

/** Fired on the window when this tab changes the language, so every reader re-reads it. */
const CHANGED = 'tp:locale';

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The interface language, and a way to change it.
 *
 * English until mounted, for `useThemeChoice`'s reason: the server has no
 * storage, and the first client render must match the server's. The page's
 * direction is right from the start — the boot script set it.
 */
export function useLocale(): {
  locale: Locale;
  /** False until storage has been read: nothing should be applied before then. */
  ready: boolean;
  setLocale: (locale: Locale) => void;
} {
  const [stored, setState] = useState<Locale | null>(null);
  useEffect(() => {
    const read = () => setState(loadLocale(storage()));
    read();
    window.addEventListener(CHANGED, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(CHANGED, read);
      window.removeEventListener('storage', read);
    };
  }, []);
  const setLocale = useCallback((next: Locale) => {
    saveLocale(storage(), next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return { locale: stored ?? 'en', ready: stored !== null, setLocale };
}

/** `t(key, vars)` in the current language. */
export function useT(): (
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
) => string {
  const { locale } = useLocale();
  return useCallback((key, vars) => translate(locale, key, vars), [locale]);
}

/** Keeps `<html lang dir>` equal to the choice. Mounted once, in the providers. */
export function LocaleSync(): null {
  const { locale, ready } = useLocale();
  useEffect(() => {
    // Not before storage is read: the boot script has already set the page,
    // and applying the default first would flip a Persian page to
    // left-to-right for a frame.
    if (ready) applyLocale(document.documentElement, locale);
  }, [locale, ready]);
  return null;
}
