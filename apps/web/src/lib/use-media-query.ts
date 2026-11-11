'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, kept current as the window changes.
 *
 * False on the server and on the first client render, so both agree; the
 * real answer arrives in the same commit as hydration, through
 * `useSyncExternalStore`, rather than an effect a frame later.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  const read = useCallback(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    [query],
  );
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Below Tailwind's `lg`: one column, the phone layout. */
export const PHONE_QUERY = '(max-width: 1023.98px)';
