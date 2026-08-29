# Two-factor authentication

`totpSecret` was a column in this schema for a long time before anything read it.
The word "2FA" appeared in `docs/security.md`, in the audit redaction list, and in
the log-scrubbing configuration — everywhere except in a code path that could
refuse a sign-in. This document describes what it does now, and why each piece is
shaped the way it is.

## The algorithm is written out, not imported

`apps/api/src/auth/totp.ts` implements RFC 6238 directly. That is a deliberate
choice against the usual advice, and it rests on one fact: **RFC 6238 and RFC 4648
publish test vectors**, so this file can be proved against the specification
rather than trusted. `totp.test.ts` runs every published vector for both.

The whole algorithm is about forty lines. A dependency would have been forty lines
plus a supply chain, in the one place where a subtly wrong answer either locks out
every user or lets anyone in.

SHA-1 is not an oversight. RFC 6238's default is HMAC-SHA-1, it is what every
authenticator app implements, and HMAC does not depend on the collision resistance
SHA-1 has lost. SHA-256 would be marginally stronger in theory and unusable in
practice.

## Enrolment is two steps, and that is the point

```
POST /auth/2fa/enrol      → secret + otpauth URI. Stores the secret. Changes nothing.
POST /auth/2fa/activate   → checks a code, switches 2FA on, returns recovery codes.
```

Between those two calls the user can sign in with a password exactly as before. If
they close the tab, scan into an app on a phone they then lose, or simply change
their mind, nothing has happened to their account.

Enrolling and enabling in one step is how people lock themselves out, and they do
it at the precise moment they were trying to be careful.

`POST /auth/2fa/enrol` called twice replaces the pending secret. The usual reason
to call it twice is that the first QR code went to a device the user no longer
has.

## A code works exactly once

`matchCode` returns **the step it matched**, not a boolean. That is the whole
design.

A TOTP code is valid for thirty seconds — thirty seconds in which anyone who saw
it can present it again: over a shoulder, through a phishing proxy, in a
screenshot pasted into a support chat. The accepted step is written to the user's
row and anything at or below it is refused afterwards.

The write is conditional and happens in the same statement as the check:

```sql
UPDATE users
   SET totp_last_step = $step
 WHERE id = $id
   AND (totp_last_step IS NULL OR totp_last_step < $step)
```

A read followed by a write would let two requests carrying the same code at the
same instant both pass. Here the second updates no rows and is refused.

A visible consequence, and the correct one: a user who activates 2FA and
immediately tries to turn it off must wait for the next code. The one they just
used is spent. Every test in this repository that performs two 2FA operations in
sequence advances a controlled clock by thirty seconds to model that, because that
is what the user experiences.

## Sign-in becomes two calls

```
POST /auth/login       → { twoFactorRequired: true, challengeToken, expiresIn }
POST /auth/login/2fa   → { accessToken, expiresIn }  + refresh cookie
```

The challenge is a JWT with `typ: '2fa'`, signed with the access secret and valid
for five minutes. The discriminator already used to keep access and refresh tokens
apart keeps this one apart from both: `verifyAccessToken` refuses it, and
`verifyTwoFactorChallenge` refuses an access token. Nothing about it is stored — a
row per abandoned login attempt would be a table that grows with every mistyped
code and is never read.

What the challenge response deliberately does **not** contain: an access token, a
refresh cookie, or any hint about the user beyond the fact that the password was
right. The smoke test asserts all three.

Note what does not happen when a challenge is issued: the failed-attempt counter
is not cleared and `lastLoginAt` is not touched. Nobody has signed in. Clearing
the counter there would let an attacker who knows the password hold the lockout
open indefinitely while grinding at the six digits.

A wrong code counts towards the same lockout a wrong password does. Six digits is
a million possibilities, which sounds ample and is not: with three steps live at
once and no limit, an attacker gets through in hours.

## Recovery codes

Ten, shown once, stored as SHA-256. SHA-256 rather than Argon2 for the same reason
refresh tokens use it: 60 bits of randomness has no low-entropy guess to slow
down.

They are formatted `4XQ7-K2M9-PT3W` because people write these down and read them
back, and the alphabet omits `O/0` and `I/1/L` for the same reason. Input is
normalised, so any case and any spacing works.

A used code is **kept, not deleted**. "When was my recovery code used" is a
question worth being able to answer, and the answer is also written to the audit
log.

Re-enrolling deletes and replaces the whole set. A code printed against a secret
that no longer exists must not still open the door.

## Turning it off costs as much as turning it on

`POST /auth/2fa/disable` requires the password **and** a live code. An attacker
holding a stolen session would otherwise simply remove the factor that was in
their way.

Disabling clears the secret, the step high-water mark and every recovery code. The
integration test asserts that nothing is left behind that could still
authenticate.

## What a failure to decrypt means

If the stored secret cannot be opened — a missing key, a tampered row — the user
gets `INTERNAL_ERROR` and the message says two-factor authentication is
unavailable for their account and to contact support. It is emphatically **not**
reported as a wrong code.

Telling a user their code is wrong when the server cannot read their secret sends
them to check their phone, their clock and their app, forever, for a problem that
is not theirs.

## Where the secret lives

Encrypted. See [encryption-at-rest.md](./encryption-at-rest.md) — including why
the ciphertext is bound to the row it belongs to, and what attack that stops.
