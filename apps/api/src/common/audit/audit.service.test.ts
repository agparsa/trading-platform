import { describe, expect, it } from 'vitest';
import { redact } from './audit.service';

describe('audit redaction', () => {
  it('removes credentials at the top level', () => {
    expect(redact({ email: 'a@b.test', password: 'hunter2' })).toEqual({
      email: 'a@b.test',
      password: '[redacted]',
    });
  });

  it('removes credentials nested inside objects and arrays', () => {
    const input = { sessions: [{ refreshToken: 'abc', ip: '1.2.3.4' }], meta: { totpSecret: 'x' } };
    expect(redact(input)).toEqual({
      sessions: [{ refreshToken: '[redacted]', ip: '1.2.3.4' }],
      meta: { totpSecret: '[redacted]' },
    });
  });

  it('matches key names case-insensitively', () => {
    expect(redact({ PasswordHash: 'x', Authorization: 'Bearer y' })).toEqual({
      PasswordHash: '[redacted]',
      Authorization: '[redacted]',
    });
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ volume: '1.00', price: '4583.65' })).toEqual({
      volume: '1.00',
      price: '4583.65',
    });
  });

  it('stops recursing on deeply nested input rather than hanging', () => {
    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('passes primitives and null through untouched', () => {
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
  });
});
