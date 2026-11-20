import { describe, expect, it } from 'vitest';
import { BRAND_BACKGROUND, accentProblem, contrastRatio, isHexColour } from './branding';

describe('branding contrast', () => {
  it('measures WCAG contrast: black on white is 21, a colour on itself is 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
  });

  it("accepts the platform's own accents on their own themes", () => {
    expect(accentProblem('#5b9cff', 'dark')).toBeNull();
    expect(accentProblem('#1c5bc8', 'light')).toBeNull();
  });

  it('refuses a dark accent on the dark theme and a light one on the light theme, saying by how much', () => {
    expect(accentProblem('#1c5bc8', 'dark')).toMatch(
      /^Too dark to read on the dark theme: \d\.\d\d:1/,
    );
    expect(accentProblem('#5b9cff', 'light')).toMatch(/^Too light to read on the light theme/);
  });

  it('accepts only #rrggbb, lower case', () => {
    expect(isHexColour('#a1b2c3')).toBe(true);
    for (const bad of ['a1b2c3', '#abc', '#A1B2C3', '#a1b2c3ff', 'red']) {
      expect(isHexColour(bad)).toBe(false);
    }
    expect(accentProblem('blue', 'dark')).toMatch(/#rrggbb/);
  });

  it('keeps the backgrounds the web theme paints', () => {
    expect(BRAND_BACKGROUND).toEqual({ dark: '#0b0e13', light: '#f4f6f9' });
  });
});
