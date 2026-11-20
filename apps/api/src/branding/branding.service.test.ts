import { describe, expect, it } from 'vitest';
import { brandingProblems } from './branding.service';

describe('brandingProblems', () => {
  it('accepts a readable change, and an empty one', () => {
    expect(
      brandingProblems({
        name: 'Acme Markets',
        accentDark: '#5b9cff',
        accentLight: '#1c5bc8',
        supportEmail: 'help@acme.example',
        websiteUrl: 'https://acme.example',
      }),
    ).toEqual([]);
    expect(brandingProblems({})).toEqual([]);
  });

  it('lets every field be cleared', () => {
    expect(
      brandingProblems({
        name: null,
        accentDark: null,
        accentLight: null,
        supportEmail: null,
        websiteUrl: null,
      }),
    ).toEqual([]);
    expect(brandingProblems({ supportEmail: '', websiteUrl: ' ' })).toEqual([]);
  });

  it('names every problem at once', () => {
    const problems = brandingProblems({
      name: 'x'.repeat(41),
      accentDark: '#101820',
      accentLight: '#ffee00',
      supportEmail: 'not an address',
      websiteUrl: 'http://acme.example',
    });
    expect(problems).toHaveLength(5);
    expect(problems[1]).toMatch(/dark theme/);
    expect(problems[2]).toMatch(/light theme/);
  });

  it('refuses a website with credentials in it, or no scheme', () => {
    expect(brandingProblems({ websiteUrl: 'https://a:b@acme.example' })).toHaveLength(1);
    expect(brandingProblems({ websiteUrl: 'acme.example' })).toHaveLength(1);
  });
});
