'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type TradingPreferences,
} from './trading-preferences';

/**
 * The trader's terminal preferences, read once and written on every change.
 *
 * Starts from the defaults rather than from storage, and loads in an effect.
 * That is not a stylistic choice: this component tree is server-rendered, and
 * reading `localStorage` during render would either crash on the server or make
 * the first client render disagree with the markup it is hydrating. The visible
 * consequence is that the terminal is briefly *disarmed* on load, which is the
 * right way round for this particular flicker.
 */
export function useTradingPreferences(): {
  preferences: TradingPreferences;
  update: (patch: Partial<TradingPreferences>) => void;
} {
  const [preferences, setPreferences] = useState<TradingPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    setPreferences(
      loadPreferences(typeof window === 'undefined' ? undefined : window.localStorage),
    );
  }, []);

  const update = useCallback((patch: Partial<TradingPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      savePreferences(typeof window === 'undefined' ? undefined : window.localStorage, next);
      return next;
    });
  }, []);

  return { preferences, update };
}
