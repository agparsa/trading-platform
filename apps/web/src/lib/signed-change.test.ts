import { describe, expect, it } from 'vitest';
import { signedChange } from './format';

describe('signedChange', () => {
  it('reads a change that rounds to nothing as flat, without a sign', () => {
    expect(signedChange('-0.0004')).toEqual({ text: '0.00%', direction: 'flat' });
    expect(signedChange('0.004')).toEqual({ text: '0.00%', direction: 'flat' });
  });

  it('signs and colours what is shown', () => {
    expect(signedChange('0.05')).toEqual({ text: '+0.05%', direction: 'up' });
    expect(signedChange('-1.236')).toEqual({ text: '-1.24%', direction: 'down' });
  });

  it('has no direction for a change that is not known', () => {
    expect(signedChange(null)).toEqual({ text: '—', direction: null });
    expect(signedChange('n/a')).toEqual({ text: '—', direction: null });
  });
});
