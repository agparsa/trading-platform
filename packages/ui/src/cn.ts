import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The terminal's own type scale (`apps/web/src/app/globals.css`, `@theme`).
 *
 * tailwind-merge has to be told these are font sizes. Not knowing them, it read
 * `text-caption` as a text *colour*, and dropped it whenever a real colour such
 * as `text-terminal-muted` came later in the same `cn()` — so every control
 * built with `cn()` fell back to the inherited 16px: the section navigation,
 * the order-type tabs, the chart's timeframes, the watchlist's categories.
 * `cn.test.ts` holds both halves: a size and a colour survive together, and
 * two sizes still resolve to the later one.
 */
export const TYPE_SCALE = ['micro', 'label', 'caption', 'body'] as const;

const merge = extendTailwindMerge({
  extend: { theme: { text: [...TYPE_SCALE] } },
});

/** Merge conditional class names, with later Tailwind utilities winning. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
