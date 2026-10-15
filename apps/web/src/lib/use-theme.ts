'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  loadThemeChoice,
  resolveTheme,
  saveThemeChoice,
  type ThemeChoice,
} from './theme';

/** Fired on the window when this tab changes the choice, so every listener re-reads it. */
const CHANGED = 'tp:theme-choice';

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The theme choice, and a way to change it.
 *
 * Read after mount rather than during render: the server has no storage, and a
 * value read during render would differ between the server pass and the first
 * client pass. The page itself is already right before then — the boot script
 * in the layout set it.
 */
export function useThemeChoice(): {
  choice: ThemeChoice | null;
  setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setState] = useState<ThemeChoice | null>(null);
  useEffect(() => {
    const read = () => setState(loadThemeChoice(storage()));
    read();
    window.addEventListener(CHANGED, read);
    // Another tab: `storage` fires there, not here.
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(CHANGED, read);
      window.removeEventListener('storage', read);
    };
  }, []);
  const setChoice = useCallback((next: ThemeChoice) => {
    saveThemeChoice(storage(), next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return { choice, setChoice };
}

/**
 * Keeps the page's theme equal to the choice — including "system", which
 * changes under the page when the operating system switches at dusk.
 * Mounted once, in the providers.
 */
export function ThemeSync(): null {
  const { choice } = useThemeChoice();
  useEffect(() => {
    if (choice === null) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(document.documentElement, resolveTheme(choice, media.matches));
    apply();
    if (choice !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);
  return null;
}

/**
 * A number that changes whenever the page's theme does — for what paints with
 * colours read from the theme rather than with CSS, which is the chart.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}
