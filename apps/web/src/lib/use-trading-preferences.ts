'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type TradingPreferences,
} from './trading-preferences';
import { useFeatures } from './queries';

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
  /** False when the firm has switched one-click trading off (§95); the setting is then ignored, not lost. */
  oneClickAllowed: boolean;
} {
  const [stored, setPreferences] = useState<TradingPreferences>(DEFAULT_PREFERENCES);
  const features = useFeatures();
  /**
   * A firm flag the client honours. The trader's own setting is kept, so a
   * firm that switches one-click back on returns everyone to what they had;
   * while it is off, the terminal behaves as though nobody had armed it.
   */
  const oneClickAllowed = features.data?.features['quick_trading'] !== false;
  const preferences = oneClickAllowed || !stored.oneClick ? stored : { ...stored, oneClick: false };

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

  return { preferences, update, oneClickAllowed };
}
