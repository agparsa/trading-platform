#!/usr/bin/env tsx
/**
 * Prints a new secret-encryption key in the form `SECRET_ENCRYPTION_KEYS` takes.
 *
 * Rotation, in full:
 *
 *   1. `pnpm keygen 2` — take the line it prints.
 *   2. Put the new key **first** and keep the old one:
 *      `SECRET_ENCRYPTION_KEYS=2:<new>,1:<old>`
 *   3. Restart. New writes use key 2; everything written under key 1 still opens.
 *   4. `pnpm rotate:secrets` re-seals the stored rows under key 2.
 *   5. Only once that has run may key 1 be dropped from the list.
 *
 * Dropping the old key at step 2 would lock every enrolled user out of their
 * second factor, and the failure would not appear until each of them next signed
 * in — which is why the key id travels inside the ciphertext.
 */
import { generateEncryptionKey } from '@tp/crypto-core';

const id = process.argv[2] ?? '1';
if (!/^[A-Za-z0-9_-]+$/.test(id)) {
  console.error(`Key id "${id}" may only contain letters, digits, dash and underscore.`);
  process.exit(1);
}

console.log(generateEncryptionKey(id));
