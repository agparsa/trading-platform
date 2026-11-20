import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_BACKGROUND } from '@tp/shared-types';
import { brandingCss } from './branding';

describe('brandingCss', () => {
  it('writes nothing when the firm has no accents', () => {
    expect(brandingCss({ accentDark: null, accentLight: null })).toBe('');
  });

  it('puts each accent on its own theme and no other', () => {
    const css = brandingCss({ accentDark: '#5b9cff', accentLight: '#1c5bc8' });
    expect(css).toContain(":root:not([data-theme='light']){--color-terminal-accent:#5b9cff}");
    expect(css).toContain(":root[data-theme='light']{--color-terminal-accent:#1c5bc8}");
    expect(brandingCss({ accentDark: '#5b9cff', accentLight: null })).not.toContain(
      "[data-theme='light']{",
    );
  });

  it('checks contrast against the backgrounds the theme actually paints', () => {
    const css = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8');
    const light = css.slice(css.indexOf(":root[data-theme='light']"));
    expect(css).toMatch(new RegExp(`--color-terminal-bg: ${BRAND_BACKGROUND.dark};`));
    expect(light).toMatch(new RegExp(`--color-terminal-bg: ${BRAND_BACKGROUND.light};`));
  });
});
