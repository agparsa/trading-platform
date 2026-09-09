import { describe, expect, it } from 'vitest';
import { parseSignature, sign, verify } from './signature';

const SECRET = 'whsec_test_0123456789abcdef';
const BODY = '{"id":"evt_1","type":"order.filled","data":{"volume":"0.10"}}';
const T = 1_725_890_000;

describe('signing a delivery', () => {
  it('produces a header a receiver with the secret verifies', () => {
    const header = sign([SECRET], T, BODY);
    expect(header).toMatch(/^t=1725890000,v1=[0-9a-f]{64}$/);
    expect(verify(header, BODY, [SECRET], T + 5, 300)).toEqual({ ok: true });
  });

  it('is deterministic for the same secret, time and bytes', () => {
    expect(sign([SECRET], T, BODY)).toBe(sign([SECRET], T, BODY));
  });

  /** The body is signed as bytes. One changed character is a different MAC. */
  it('does not verify a body that was altered by one character', () => {
    const header = sign([SECRET], T, BODY);
    expect(verify(header, BODY.replace('0.10', '0.11'), [SECRET], T, 300)).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it('does not verify with the wrong secret', () => {
    const header = sign([SECRET], T, BODY);
    expect(verify(header, BODY, ['whsec_other'], T, 300)).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  /**
   * The replay defence. The timestamp is inside the MAC, so a receiver that
   * refuses old timestamps refuses a captured delivery without remembering
   * what it has seen — and an attacker cannot freshen the timestamp without
   * the secret.
   */
  it('refuses a delivery that is older than the tolerance', () => {
    const header = sign([SECRET], T, BODY);
    expect(verify(header, BODY, [SECRET], T + 301, 300)).toEqual({ ok: false, reason: 'STALE' });
    expect(verify(header, BODY, [SECRET], T + 300, 300)).toEqual({ ok: true });
  });

  it('refuses a timestamp that was freshened without the secret', () => {
    const header = sign([SECRET], T, BODY).replace(`t=${T}`, `t=${T + 1000}`);
    expect(verify(header, BODY, [SECRET], T + 1000, 300)).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it('refuses a delivery from the future beyond the tolerance too', () => {
    const header = sign([SECRET], T + 1000, BODY);
    expect(verify(header, BODY, [SECRET], T, 300)).toEqual({ ok: false, reason: 'STALE' });
  });

  /** Rotation: the old and the new secret both sign, and either verifies. */
  it('signs with every secret during a rotation, so either side verifies', () => {
    const header = sign(['new-secret', SECRET], T, BODY);
    expect(parseSignature(header)?.digests).toHaveLength(2);
    expect(verify(header, BODY, [SECRET], T, 300)).toEqual({ ok: true });
    expect(verify(header, BODY, ['new-secret'], T, 300)).toEqual({ ok: true });
  });

  it('refuses to sign without a secret or with a nonsense time', () => {
    expect(() => sign([], T, BODY)).toThrow(/without a secret/);
    expect(() => sign([SECRET], 0, BODY)).toThrow(/timestamp/);
    expect(() => sign([SECRET], 1.5, BODY)).toThrow(/timestamp/);
  });
});

describe('parsing the header', () => {
  it('reads the documented shape and ignores keys it does not know', () => {
    expect(parseSignature(`t=${T},v1=${'a'.repeat(64)},v9=whatever`)).toEqual({
      timestamp: T,
      digests: ['a'.repeat(64)],
    });
  });

  it.each([
    ['', 'empty'],
    [`v1=${'a'.repeat(64)}`, 'no timestamp'],
    [`t=${T}`, 'no digest'],
    [`t=${T},t=${T},v1=${'a'.repeat(64)}`, 'two timestamps'],
    [`t=abc,v1=${'a'.repeat(64)}`, 'a timestamp that is not a number'],
    [`t=${T},v1=${'a'.repeat(63)}`, 'a digest of the wrong length'],
    [`t=${T},v1=${'g'.repeat(64)}`, 'a digest that is not hex'],
    [`t=${T},=x,v1=${'a'.repeat(64)}`, 'an empty key'],
    ['t=1,v1=' + 'a'.repeat(64) + ',' + 'x'.repeat(5000), 'absurdly long'],
  ])('refuses %s (%s)', (header) => {
    expect(parseSignature(header)).toBeNull();
    expect(verify(header, BODY, [SECRET], T, 300)).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('refuses a null or undefined header', () => {
    expect(parseSignature(null)).toBeNull();
    expect(parseSignature(undefined)).toBeNull();
  });
});
