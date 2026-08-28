'use client';

import { useEffect } from 'react';
import { actionFor, type ShortcutAction } from './shortcuts';
import type { TradingPreferences } from './trading-preferences';

/**
 * Binds keyboard trading to the document.
 *
 * The listener is thin on purpose — it turns a `KeyboardEvent` into the shape
 * `actionFor` wants and does as it is told. Every decision about what a
 * keystroke means, and when it means nothing, lives in `shortcuts.ts` where it
 * is tested without a DOM.
 */
export function useTradingShortcuts(
  preferences: TradingPreferences,
  onAction: (action: ShortcutAction) => void,
): void {
  useEffect(() => {
    if (!preferences.keyboard) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const action = actionFor(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          target: event.target as { tagName?: string; isContentEditable?: boolean } | null,
        },
        preferences.keys,
        preferences.keyboard,
      );
      if (action === null) return;
      // Only once the keystroke is known to mean something: swallowing keys the
      // terminal does not use would break find-in-page and the browser's own
      // shortcuts for no reason.
      event.preventDefault();
      onAction(action);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [preferences.keyboard, preferences.keys, onAction]);
}
