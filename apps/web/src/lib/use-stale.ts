'use client';

import { useEffect, useState } from 'react';

/**
 * How long a price may go without a new quote before the screen says so.
 * Twice the server's own limit for trading on a quote (`QUOTE_MAX_AGE_MS`,
 * 5 s), so a slow but healthy feed does not flicker the warning.
 */
export const STALE_AFTER_MS = 10_000;

/**
 * True when `version` — a quote's timestamp — has not changed for
 * STALE_AFTER_MS while `active` (the market is open and a quote exists).
 *
 * Measured on this device's clock from when the quote *arrived*, not from
 * the server's timestamp: a phone whose clock is a minute off would
 * otherwise call every price stale, or none. One timer per change, no
 * polling.
 */
export function useStale(version: unknown, active: boolean): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
    if (!active) return;
    const timer = setTimeout(() => setStale(true), STALE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [version, active]);
  return stale;
}
