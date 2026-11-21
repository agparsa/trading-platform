import { describe, expect, it } from 'vitest';
import { roleLabel } from './role-label';

describe('roleLabel', () => {
  it('says a role code in words', () => {
    expect(roleLabel('PLATFORM_SUPER_ADMIN')).toBe('Platform super admin');
    expect(roleLabel('ADMIN')).toBe('Admin');
    expect(roleLabel('BROKER_OWNER')).toBe('Broker owner');
  });
  it('leaves something it cannot read as it was', () => {
    expect(roleLabel('_')).toBe('_');
  });
});
