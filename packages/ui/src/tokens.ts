/**
 * Terminal design tokens.
 *
 * A trading terminal is read at a glance under stress. The palette is dense and
 * low-chroma so that the only saturated colour on screen is a number that
 * changed — profit, loss, or a rule breach.
 */
export const terminalTokens = {
  color: {
    bg: 'var(--tp-bg)',
    surface: 'var(--tp-surface)',
    surfaceRaised: 'var(--tp-surface-raised)',
    border: 'var(--tp-border)',
    text: 'var(--tp-text)',
    textMuted: 'var(--tp-text-muted)',
    long: 'var(--tp-long)',
    short: 'var(--tp-short)',
    profit: 'var(--tp-profit)',
    loss: 'var(--tp-loss)',
    warning: 'var(--tp-warning)',
  },
  /** Tabular figures everywhere numbers change in place, so digits do not jitter. */
  font: {
    numeric: 'var(--tp-font-numeric)',
  },
} as const;

export type SignedTone = 'profit' | 'loss' | 'flat';

/**
 * Classify a signed decimal string for display.
 * '-0.00' and '0' are both flat: a value that rounds to zero must not be
 * painted red just because it carries a minus sign.
 */
export function toneOf(value: string): SignedTone {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 'flat';
  return numeric > 0 ? 'profit' : 'loss';
}
