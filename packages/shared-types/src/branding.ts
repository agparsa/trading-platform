/**
 * A firm's branding, and the one rule it cannot break: the accent stays
 * readable.
 *
 * The accent is the colour of links, the selected tab and the primary
 * button's face, with the page's own background colour as the button's text.
 * Contrast is symmetric, so one check — the accent against the page — covers
 * both the link on the page and the label on the button. 4.5:1 is WCAG's
 * figure for body text; a brand colour that fails it would make the platform
 * harder to read for everyone who trades on it, so it is refused rather than
 * warned about.
 */

/** What `GET /branding` serves: every field optional, `null` meaning "the platform's own". */
export interface Branding {
  readonly name: string | null;
  readonly accentDark: string | null;
  readonly accentLight: string | null;
  readonly supportEmail: string | null;
  readonly websiteUrl: string | null;
}

/** The page backgrounds each accent is drawn on — `globals.css`, both themes. */
export const BRAND_BACKGROUND = { dark: '#0b0e13', light: '#f4f6f9' } as const;

/** WCAG's minimum for text, which the accent is. */
export const BRAND_MIN_CONTRAST = 4.5;

export const BRAND_NAME_MAX = 40;

const HEX = /^#[0-9a-f]{6}$/;

export function isHexColour(value: string): boolean {
  return HEX.test(value);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Why an accent cannot be used on a theme, or `null` when it can. The words
 * are shown to the person choosing it, on the admin page and from the server.
 */
export function accentProblem(hex: string, theme: 'dark' | 'light'): string | null {
  if (!isHexColour(hex)) return 'Write the colour as #rrggbb, for example #3b82f6.';
  const ratio = contrastRatio(hex, BRAND_BACKGROUND[theme]);
  if (ratio >= BRAND_MIN_CONTRAST) return null;
  return `Too ${theme === 'dark' ? 'dark' : 'light'} to read on the ${theme} theme: ${ratio.toFixed(2)}:1 against its background, and text needs ${BRAND_MIN_CONTRAST}:1.`;
}
