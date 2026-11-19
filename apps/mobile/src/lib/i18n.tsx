import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import * as Localization from 'expo-localization';
import { deviceLocale, translate, type Locale, type Translate } from './messages';
import { secureStore } from './secure-store';

export { translate, type Translate };

const STORED = 'tp.locale';

/** The languages the app offers. */
export const OFFERED: readonly Locale[] = ['en'];

function offered(locale: Locale): Locale {
  return OFFERED.includes(locale) ? locale : 'en';
}

interface LocaleContextValue {
  readonly locale: Locale;
  readonly rtl: boolean;
  readonly t: Translate;
  readonly setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  rtl: false,
  t: (key, vars) => translate('en', key, vars),
  setLocale: () => undefined,
});

/**
 * The app's language, and its direction.
 *
 * Persian reads right to left, so the whole tree is laid out with Yoga's
 * `direction: 'rtl'` rather than `I18nManager.forceRTL`, which only takes
 * effect after the app restarts. Rows mirror, text aligns to the start;
 * numbers keep `writingDirection: 'ltr'` (see `direction.ts`) because a price
 * is a number in every language.
 *
 * The choice is remembered on the device. Until one is made, the phone's own
 * language decides.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  /**
   * English only, by the owner's decision (19 November). The Persian
   * dictionary stays complete and tested; offering it again is `OFFERED`.
   * A choice stored before then, or a Persian phone, reads as English.
   */
  const [locale, setLocaleState] = useState<Locale>(() =>
    offered(deviceLocale(Localization.getLocales()[0]?.languageTag)),
  );

  useEffect(() => {
    void secureStore
      .get(STORED)
      .then((stored) => {
        if (stored === 'fa' || stored === 'en') setLocaleState(offered(stored));
      })
      .catch(() => undefined);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(offered(next));
    void secureStore.set(STORED, next).catch(() => undefined);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      rtl: locale === 'fa',
      t: (key, vars) => translate(locale, key, vars),
      setLocale,
    }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <View style={{ flex: 1, direction: value.rtl ? 'rtl' : 'ltr' }}>{children}</View>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useT(): Translate {
  return useContext(LocaleContext).t;
}
