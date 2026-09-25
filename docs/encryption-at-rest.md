# Encryption at rest

Almost nothing in this database is stored reversibly. Passwords are Argon2id;
refresh tokens, email-verification links and password-reset links are SHA-256. All
one-way, because the server never needs the original back.

The TOTP shared secret is the exception. Verifying a six-digit code requires the
secret itself, so it has to survive in a form the server can read — which makes it
the one row a database dump would hand an attacker something usable. With the
shared secrets, they can generate valid second factors for every enrolled user,
indefinitely.

`packages/crypto-core/src/secret-box.ts` moves that target from the database to
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

```bash
pnpm keygen 2                     # 1. prints 2:<base64>
                                  # 2. SECRET_ENCRYPTION_KEYS=2:<new>,1:<old>
                                  # 3. restart: new writes use key 2
pnpm rotate:secrets               #    what is sealed under which key
pnpm rotate:secrets --apply       # 4. re-seal everything under key 2
pnpm rotate:secrets --assert-current   # 5. exits 1 if anything is left behind
                                  #    only now may key 1 be dropped
```

Step 5 is the dangerous one, and it is the reason the tool exists. Dropping a key
that is still holding rows makes those rows unreadable — permanently, and one
user at a time over the following weeks, as each next signs in or a reviewer next
opens a document. `--assert-current` is the gate to put in front of it.

### This step had no mechanism, and the procedure said to do it anyway

Steps 1, 2, 3 and 5 were here from the start. Step 4 read "re-seal the stored
rows under key 2", and **nothing in the repository could do that.** There was no
job and no script; `SecretBox.rotate` handled the text form only, so identity
documents and built reports — the two largest sealed columns in the platform —
could not be re-sealed at all. The sentence describing a rotation job was a
description of something that did not exist.

An operator working down this list, finding nothing to run at step 4, and
assuming the restart in step 3 had done the re-sealing would reach step 5 and
drop a key holding every enrolled second factor, every identity document, every
venue credential and every withdrawal destination in the deployment.

### Why writing it was harder than it looks

Not the cryptography. A sealed value cannot be re-sealed without the **context**
it was bound to as additional authenticated data, and each context lived as a
private helper beside the code that sealed it — `contextFor` in the TOTP
service, `sealContext` in devices, a bare row id in webhooks and venue
credentials. A rotation job would have had to re-derive seven of those from
memory, and getting one wrong means a column of values that no longer open.

So they moved to [`sealed-columns.ts`](../packages/crypto-core/src/sealed-columns.ts),
which is now the single answer to "what is sealed in this system": eight columns
across seven tables, each with the builder for its own AAD. The call sites import
from it. `rotation.test.ts` checks the list against two things it does not
control — the Prisma schema, so a declared column must exist, and every
seal and open in both applications, so **no call site may invent its own
context**.

That check found one immediately: `push.service.ts` opened a device token with
a `device:${userId}:${installationId}` template written out by hand, a third copy
of an AAD that the rotation would have had no way to know about.

### What the tool will not do

- **It will not clear a row it cannot open.** The commonest cause is a key
  retired too early — exactly the mistake above — and that is recoverable: the
  value is still there and opens the moment the key is put back. The row is
  named, the walk continues, and the exit code is non-zero.
- **It will not write a value it has not read back.** Every re-sealed value is
  opened again, under the same context, before the update runs.
- **It will not change a document's bytes on its own.** `kyc_documents` refuses
  an update that changes `content` while leaving `sealed_with_key_id` alone —
  a trigger written with a rotation in mind before there was one. A rotation
  that forgot to record the key would not leave a stale column behind; it would
  not commit.
- **It does not need a key to answer step 5's question.** Both sealed forms
  carry their key id in the clear, so the check is safe to run by somebody who
  cannot decrypt anything.

## Identity documents

Since phase 6 the sealing key also protects `kyc_documents.content` — a scan of
somebody's passport — which is a larger and more consequential thing than a TOTP
secret. `SecretBox.sealBytes` / `openBytes` are the binary form: a fixed header
rather than base64, so a ten-megabyte document costs a few dozen bytes more
rather than a third more. The row id is the AAD, so a document copied into
another person's row will not open there. `kyc_documents.sealed_with_key_id`
carries the key id outside the frame so a rotation job can find rows without
opening each one — and `pnpm rotate:secrets` is that job.

Dropping a key that wrote any document makes those documents unreadable to a
reviewer, and the failure surfaces only when somebody opens one. The order
above is not optional here either. See [kyc.md](./kyc.md).

## What is deliberately not encrypted

Everything already hashed. Adding encryption on top of Argon2 would protect
nothing that matters and add a key whose loss would destroy every password in the
system.

Order, position, trade and ledger rows are not encrypted either. They are the
records this platform exists to keep, they are read on every request, and an
encryption layer over them would buy secrecy against an attacker who already has
the database while costing correctness, queryability and every index. The defence
there is access control and the audit trail, not a cipher.
