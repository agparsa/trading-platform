import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encryption at rest for the few secrets that must be readable again.
 *
 * Almost nothing in this database is stored reversibly. Passwords are Argon2id,
 * refresh tokens and single-use links are SHA-256 — all of them one-way, because
 * the server never needs the original back. A TOTP shared secret is the
 * exception: verifying a six-digit code requires the secret itself, so it has to
 * survive in a form the server can read.
 *
 * That makes it the one row a database dump would hand an attacker something
 * usable: with the shared secrets, they can generate valid second factors for
 * every enrolled user, for as long as those users stay enrolled. Encrypting it
 * moves the target from the database to the key, which lives somewhere else.
 *
 * ## The stored form
 *
 * ```
 * v1.<keyId>.<iv>.<tag>.<ciphertext>
 * ```
 *
 * Self-describing on purpose. A value in a column says which key made it, so
 * rotation does not need a flag day: add the new key at the front of the list,
 * old ciphertexts keep decrypting under the key that wrote them, and anything
 * rewritten is rewritten under the new one. A format that did not record the key
 * would force every row to be migrated in one transaction, which is exactly the
 * operation nobody wants to perform on the day a key has leaked.
 *
 * ## Why the context string is not optional
 *
 * Every `seal` takes a context — `user:<id>:totp` — and it goes in as GCM
 * additional authenticated data. It is not encrypted; it is *bound*. Decrypting
 * with a different context fails.
 *
 * This defends against an attacker who can write to the database but cannot read
 * the key: without the binding they could copy the TOTP ciphertext out of an
 * account they control into the victim's row and then authenticate as the victim
 * with their own authenticator app. The ciphertext is valid, the key is right,
 * and the plaintext comes back — the encryption did its job and the attack still
 * worked. With the binding, the copied value fails to open in its new row.
 */

export interface EncryptionKey {
  id: string;
  key: Buffer;
}

const FORMAT = 'v1';
const ALGORITHM = 'aes-256-gcm';
/** 96 bits. The size GCM is specified for; anything else weakens it. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    // Deliberately says nothing about the key, the context or the value. This
    // message can reach a log; the details are for the caller's own reasoning,
    // not for anyone reading the log later.
    super(`Stored secret could not be decrypted: ${reason}`);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Parses `id:base64key,id:base64key` into keys, newest first.
 *
 * Throws on anything malformed rather than skipping it. A key list where one
 * entry was silently dropped is a key list that decrypts most rows.
 */
export function parseEncryptionKeys(raw: string): EncryptionKey[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) throw new Error('no keys');

  const keys: EncryptionKey[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new Error('an entry is not in the form <id>:<base64 key>');
    const id = entry.slice(0, separator);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('a key id contains unusable characters');
    if (seen.has(id)) throw new Error(`the key id ${id} appears twice`);
    seen.add(id);

    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`the key ${id} is ${key.length} bytes; ${KEY_BYTES} are required`);
    }
    keys.push({ id, key });
  }
  return keys;
}

/** Generates a key in the configured form. Used by `pnpm keygen` and by tests. */
export function generateEncryptionKey(id: string): string {
  return `${id}:${randomBytes(KEY_BYTES).toString('base64')}`;
}

export class SecretBox {
  private readonly byId: Map<string, Buffer>;
  private readonly active: EncryptionKey;

  constructor(keys: readonly EncryptionKey[]) {
    if (keys.length === 0) throw new Error('SecretBox needs at least one key');
    const first = keys[0];
    if (first === undefined) throw new Error('SecretBox needs at least one key');
    this.active = first;
    this.byId = new Map(keys.map((entry) => [entry.id, entry.key]));
  }

  /** The key new writes use. Exposed so an operator can confirm a rotation took. */
  get activeKeyId(): string {
    return this.active.id;
  }

  seal(plaintext: string, context: string): string {
    if (context.length === 0) throw new Error('a sealed secret must be bound to a context');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.active.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT,
      this.active.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open(sealed: string, context: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 5)
      throw new SecretDecryptionError('the stored value is not in the expected form');
    const [format, keyId, ivPart, tagPart, ciphertextPart] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (format !== FORMAT) throw new SecretDecryptionError(`unknown format ${format}`);

    const key = this.byId.get(keyId);
    if (key === undefined) {
      // The commonest cause by far is a key that was retired too early. Naming
      // the id — which is not secret, it is written in the column — is what
      // turns a mystifying failure into a one-line fix.
      throw new SecretDecryptionError(`no key with id ${keyId} is configured`);
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretDecryptionError('the stored value is malformed');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // GCM cannot tell us *why*: a wrong key, a wrong context and a tampered
      // ciphertext all fail identically, and that is the property we want. What
      // matters here is that it fails loudly rather than returning something.
      throw new SecretDecryptionError('authentication failed');
    }
  }

  /**
   * Re-seals a value under the active key, if it is not already under it.
   *
   * Returns `null` when nothing needs doing, so a rotation job can walk a table
   * and write only the rows that changed.
   */
  rotate(sealed: string, context: string): string | null {
    const keyId = sealed.split('.')[1];
    if (keyId === this.active.id) return null;
    return this.seal(this.open(sealed, context), context);
  }

  /** Constant-time comparison, for callers checking a decrypted secret. */
  static equals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
