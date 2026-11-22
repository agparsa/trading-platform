import { describe, expect, it } from 'vitest';
import { brandName } from './branding';

const none = {
  name: null,
  accentDark: null,
  accentLight: null,
  supportEmail: null,
  websiteUrl: null,
};

describe('brandName', () => {
  it('is the firm’s name when it has one', () => {
    expect(brandName({ ...none, name: 'Acme Markets' }, 'Trading Platform')).toBe('Acme Markets');
  });
  it('falls back while branding is unknown, unset or blank', () => {
    expect(brandName(null, 'Trading Platform')).toBe('Trading Platform');
    expect(brandName(none, 'Trading Platform')).toBe('Trading Platform');
    expect(brandName({ ...none, name: '  ' }, 'Trading Platform')).toBe('Trading Platform');
  });
});
