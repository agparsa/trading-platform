import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  generateEncryptionKey,
  parseEncryptionKeys,
  SecretBox,
  SecretDecryptionError,
} from './secret-box';

const KEY_A = generateEncryptionKey('a');
const KEY_B = generateEncryptionKey('b');

const boxWith = (...raw: string[]) => new SecretBox(parseEncryptionKeys(raw.join(',')));

describe('SecretBox', () => {
  it('returns what was sealed', () => {
    const box = boxWith(KEY_A);
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user:1:totp');
    expect(box.open(sealed, 'user:1:totp')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('does not store the plaintext anywhere in the sealed value', () => {
    const sealed = boxWith(KEY_A).seal('JBSWY3DPEHPK3PXP', 'user:1:totp');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    // Nor the base64/base64url of it, which is the way this usually leaks.
    expect(sealed).not.toContain(Buffer.from('JBSWY3DPEHPK3PXP').toString('base64url'));
  });

  it('produces a different ciphertext every time, so equal secrets are not visibly equal', () => {
    const box = boxWith(KEY_A);
    const first = box.seal('same', 'user:1:totp');
    const second = box.seal('same', 'user:2:totp');
    expect(first).not.toBe(second);
    // Even under the identical context, where only the IV differs.
    expect(box.seal('same', 'user:1:totp')).not.toBe(first);
  });

  /**
   * The attack this defends against: someone who can write to the database but
   * cannot read the key copies a TOTP ciphertext from an account they control
   * into the victim's row, then signs in as the victim with their own
   * authenticator. Everything about that ciphertext is legitimate — right key,
   * intact tag — and without the binding it would open.
   */
  it('refuses a value moved to another row', () => {
    const box = boxWith(KEY_A);
    const attackers = box.seal('JBSWY3DPEHPK3PXP', 'user:attacker:totp');
    expect(() => box.open(attackers, 'user:victim:totp')).toThrow(SecretDecryptionError);
  });

  it('refuses a tampered ciphertext rather than returning altered plaintext', () => {
    const box = boxWith(KEY_A);
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user:1:totp');
    const parts = sealed.split('.');
    const body = Buffer.from(parts[4] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0x01;
    parts[4] = body.toString('base64url');
    expect(() => box.open(parts.join('.'), 'user:1:totp')).toThrow(SecretDecryptionError);
  });

  it('refuses a value sealed under a key it does not have', () => {
    const sealed = boxWith(KEY_B).seal('secret', 'ctx');
    expect(() => boxWith(KEY_A).open(sealed, 'ctx')).toThrow(/no key with id b/);
  });

  it('refuses to seal without a context', () => {
    expect(() => boxWith(KEY_A).seal('secret', '')).toThrow(/context/);
  });

  describe('key rotation', () => {
    it('still opens values written under a retired key', () => {
      const old = boxWith(KEY_B);
      const sealed = old.seal('written-long-ago', 'ctx');

      // The new key goes at the front; the old one stays in the list.
      const rotated = boxWith(KEY_A, KEY_B);
      expect(rotated.open(sealed, 'ctx')).toBe('written-long-ago');
      expect(rotated.activeKeyId).toBe('a');
    });

    it('writes new values under the active key', () => {
      const sealed = boxWith(KEY_A, KEY_B).seal('new', 'ctx');
      expect(sealed.split('.')[1]).toBe('a');
    });

    it('re-seals an old value and reports nothing to do for a current one', () => {
      const rotated = boxWith(KEY_A, KEY_B);
      const old = boxWith(KEY_B).seal('value', 'ctx');

      const resealed = rotated.rotate(old, 'ctx');
      expect(resealed).not.toBeNull();
      expect(resealed?.split('.')[1]).toBe('a');
      expect(rotated.open(resealed ?? '', 'ctx')).toBe('value');

      expect(rotated.rotate(resealed ?? '', 'ctx')).toBeNull();
    });
  });

  describe('key parsing', () => {
    it('refuses a key of the wrong length rather than padding it', () => {
      const short = `x:${randomBytes(16).toString('base64')}`;
      expect(() => parseEncryptionKeys(short)).toThrow(/16 bytes/);
    });

    it('refuses an empty list', () => {
      expect(() => parseEncryptionKeys('   ')).toThrow(/no keys/);
      expect(() => parseEncryptionKeys(',,')).toThrow(/no keys/);
    });

    it('refuses a duplicate id, which would make ciphertexts ambiguous', () => {
      expect(() => parseEncryptionKeys(`${KEY_A},${generateEncryptionKey('a')}`)).toThrow(/twice/);
    });

    it('refuses an entry with no id', () => {
      expect(() => parseEncryptionKeys(randomBytes(32).toString('base64'))).toThrow(/<id>:/);
    });

    it('keeps the order given, because the first key is the one that writes', () => {
      expect(parseEncryptionKeys(`${KEY_B},${KEY_A}`).map((k) => k.id)).toEqual(['b', 'a']);
    });
  });

  describe('equals', () => {
    it('compares without leaking length through an early return', () => {
      expect(SecretBox.equals('abc', 'abc')).toBe(true);
      expect(SecretBox.equals('abc', 'abd')).toBe(false);
      expect(SecretBox.equals('abc', 'abcd')).toBe(false);
    });
  });
});
