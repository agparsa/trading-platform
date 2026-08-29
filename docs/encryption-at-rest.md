# Encryption at rest

Almost nothing in this database is stored reversibly. Passwords are Argon2id;
refresh tokens, email-verification links and password-reset links are SHA-256. All
one-way, because the server never needs the original back.

The TOTP shared secret is the exception. Verifying a six-digit code requires the
secret itself, so it has to survive in a form the server can read — which makes it
the one row a database dump would hand an attacker something usable. With the
shared secrets, they can generate valid second factors for every enrolled user,
indefinitely.

`apps/api/src/common/crypto/secret-box.ts` moves that target from the database to
the key.

## The stored form

```
v1.<keyId>.<iv>.<tag>.<ciphertext>
```

AES-256-GCM. The IV is 96 bits, the size GCM is specified for.

It is self-describing on purpose. A value in a column says which key made it, so
rotation does not need a flag day. A format without the key id would force every
row to be migrated in one transaction — precisely the operation nobody wants to
perform on the day a key has leaked.

## The context string is not optional

Every `seal` takes a context — `user:<id>:totp` — which goes in as GCM additional
authenticated data. It is not encrypted; it is **bound**. Decrypting under a
different context fails.

This defends against an attacker who can write to the database but cannot read the
key. Without the binding, they could copy the TOTP ciphertext out of an account
they control into the victim's row and then authenticate as the victim using their
own authenticator app. The ciphertext is valid, the key is right, the plaintext
comes back — the encryption did its job and the attack still worked.

There is a test for exactly that, in `secret-box.test.ts` and again end-to-end in
`two-factor.test.ts`.

## Configuration

```
SECRET_ENCRYPTION_KEYS=<id>:<base64 32 bytes>[,<older id>:<older key>...]
```

Newest first. The first key writes; the rest exist so values sealed under a retired
key still open. The API refuses to boot without it, and refuses to boot on a
malformed list — validated with the same parser the application uses, so there is
only ever one definition of a usable key list.

Validation errors name the variable and never echo a key.

## Rotating a key

1. `pnpm keygen 2` — prints `2:<base64>`.
2. Put the new key **first** and keep the old one:
   `SECRET_ENCRYPTION_KEYS=2:<new>,1:<old>`
3. Restart. New writes use key 2; everything written under key 1 still opens.
4. Re-seal the stored rows under key 2 (`SecretBox.rotate` returns `null` for a row
   already under the active key, so a rotation job writes only what changed).
5. **Only then** may key 1 be dropped from the list.

Dropping the old key at step 2 would lock every enrolled user out of their second
factor, and the failure would not surface until each of them next signed in. That
is why the key id travels inside the ciphertext.

## What is deliberately not encrypted

Everything already hashed. Adding encryption on top of Argon2 would protect
nothing that matters and add a key whose loss would destroy every password in the
system.

Order, position, trade and ledger rows are not encrypted either. They are the
records this platform exists to keep, they are read on every request, and an
encryption layer over them would buy secrecy against an attacker who already has
the database while costing correctness, queryability and every index. The defence
there is access control and the audit trail, not a cipher.
