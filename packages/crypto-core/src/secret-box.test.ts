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

describe('SecretBox with bytes', () => {
  const document = randomBytes(3 * 1024 * 1024); // the shape of a phone photograph

  it('returns exactly what was sealed, byte for byte', () => {
    const box = boxWith(KEY_A);
    const sealed = box.sealBytes(document, 'kyc:doc:1');
    expect(box.openBytes(sealed, 'kyc:doc:1').equals(document)).toBe(true);
  });

  it('costs a fixed header and not a third more, which is why it exists', () => {
    const box = boxWith(KEY_A);
    const sealed = box.sealBytes(document, 'kyc:doc:1');
    // format + length + key id + iv + tag, and nothing proportional to the payload.
    expect(sealed.length - document.length).toBeLessThan(64);
  });

  it('does not contain the plaintext', () => {
    const box = boxWith(KEY_A);
    const marker = Buffer.from('THIS IS A PASSPORT NUMBER 123456789');
    const sealed = box.sealBytes(marker, 'kyc:doc:1');
    expect(sealed.includes(marker)).toBe(false);
  });

  it('refuses a document moved to another person’s row', () => {
    const box = boxWith(KEY_A);
    const sealed = box.sealBytes(document, 'kyc:doc:alice');
    expect(() => box.openBytes(sealed, 'kyc:doc:mallory')).toThrow(SecretDecryptionError);
  });

  it('refuses a single flipped byte anywhere in the ciphertext', () => {
    const box = boxWith(KEY_A);
    const sealed = box.sealBytes(document, 'kyc:doc:1');
    const tampered = Buffer.from(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => box.openBytes(tampered, 'kyc:doc:1')).toThrow(SecretDecryptionError);
  });

  it('refuses a value sealed under a key it does not have, naming the key', () => {
    const sealed = boxWith(KEY_B).sealBytes(document, 'kyc:doc:1');
    expect(() => boxWith(KEY_A).openBytes(sealed, 'kyc:doc:1')).toThrow(/no key with id/);
  });

  it('still opens under a retired key that is kept in the list', () => {
    const sealed = boxWith(KEY_A).sealBytes(document, 'kyc:doc:1');
    const rotated = boxWith(KEY_B, KEY_A);
    expect(rotated.openBytes(sealed, 'kyc:doc:1').equals(document)).toBe(true);
    expect(SecretBox.keyIdOfBytes(sealed)).toBe(parseEncryptionKeys(KEY_A)[0]?.id);
  });

  /**
   * The byte twin of the text rotation, which did not exist until a rotation
   * job needed it — and until then identity documents and built reports, the
   * two largest sealed columns in the platform, could not be re-sealed at all.
   */
  it('re-seals old bytes and reports nothing to do for current ones', () => {
    const rotated = boxWith(KEY_A, KEY_B);
    const old = boxWith(KEY_B).sealBytes(document, 'kyc:doc:1');

    const resealed = rotated.rotateBytes(old, 'kyc:doc:1');
    expect(resealed).not.toBeNull();
    expect(SecretBox.keyIdOfBytes(resealed ?? Buffer.alloc(0))).toBe(
      parseEncryptionKeys(KEY_A)[0]?.id,
    );
    expect(rotated.openBytes(resealed ?? Buffer.alloc(0), 'kyc:doc:1').equals(document)).toBe(true);

    expect(rotated.rotateBytes(resealed ?? Buffer.alloc(0), 'kyc:doc:1')).toBeNull();
  });

  /**
   * A re-seal is bound to the same context or it is not a re-seal.
   *
   * Rotating under the wrong AAD would produce a value that looks perfectly
   * healthy — right key id, right frame — and refuses to open in the row it
   * came from. That is the failure mode a rotation must not have, because it is
   * discovered later, one document at a time.
   */
  it('re-seals under the same context, not merely under the same key', () => {
    const rotated = boxWith(KEY_A, KEY_B);
    const old = boxWith(KEY_B).sealBytes(document, 'kyc:doc:1');
    const resealed = rotated.rotateBytes(old, 'kyc:doc:1') ?? Buffer.alloc(0);

    expect(() => rotated.openBytes(resealed, 'kyc:doc:2')).toThrow(SecretDecryptionError);
  });

  it('refuses garbage rather than guessing at it', () => {
    const box = boxWith(KEY_A);
    for (const junk of [
      Buffer.alloc(0),
      Buffer.from([0x01]),
      Buffer.from([0x02, 0x02, 0x6b, 0x31]),
      randomBytes(40),
    ]) {
      expect(() => box.openBytes(junk, 'kyc:doc:1')).toThrow(SecretDecryptionError);
    }
    expect(SecretBox.keyIdOfBytes(Buffer.alloc(0))).toBeNull();
  });

  it('refuses to seal without a context, like the text form', () => {
    expect(() => boxWith(KEY_A).sealBytes(document, '')).toThrow(/bound to a context/);
  });
});
