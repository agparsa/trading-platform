/**
 * Display formatting.
 *
 * Every value shown in the terminal arrives from the server as a decimal string
 * and is formatted for display here. Nothing is computed client-side: a number
 * on screen that the server did not produce is a number nobody can reconcile.
 *
 * `Number()` appears below only to add thousands separators. It never feeds a
 * value back into a request — order payloads carry the original strings.
 */
export function money(value: string | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

/** Signed money, with an explicit + so a profit is unmistakable at a glance. */
export function signedMoney(value: string | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const formatted = money(value, currency);
  return numeric > 0 ? `+${formatted}` : formatted;
}

/** Prices keep the instrument's own precision, so 1.08750 does not become 1.09. */
export function price(value: string | null | undefined, precision = 2): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(precision);
}

export function percent(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric.toFixed(digits)}%`;
}

export function volume(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(2);
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function utcTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
}

export type Tone = 'profit' | 'loss' | 'flat';

/**
 * `-0.00` and `0` are both flat. A value that rounds to zero must not be painted
 * red just because it carries a minus sign.
 */
export function toneOf(value: string | null | undefined): Tone {
  if (value === null || value === undefined) return 'flat';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 'flat';
  return numeric > 0 ? 'profit' : 'loss';
}

export const toneClass: Record<Tone, string> = {
  profit: 'text-terminal-long',
  loss: 'text-terminal-short',
  flat: 'text-terminal-muted',
};
