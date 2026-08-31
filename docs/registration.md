# Registration

Who may open an account, and how the platform is stopped from being a public
sign-up sheet by accident.

## The three modes

`REGISTRATION_MODE` takes one of three values.

| Mode     | Who gets in                                           |
| -------- | ----------------------------------------------------- |
| `open`   | Anyone with the URL                                   |
| `invite` | Anyone holding a valid, unexpired, unspent invitation |
| `closed` | Nobody. Existing users sign in as normal              |

The default is `open`, because that is how a developer expects a fresh checkout
to behave and making them configure sign-up before they can register once is a
bad first five minutes.

## Why production refuses to boot on the default

`NODE_ENV=production` with `REGISTRATION_MODE=open` **stops the process
starting**, unless `REGISTRATION_ALLOW_OPEN_IN_PRODUCTION=true` is also set.

A public hostname that accepts any registration is not a configuration somebody
chooses. It is one nobody made — the default was left where it fell and the
deployment inherited it. There is no moment after boot at which anyone is
reliably looking, so the refusal happens at the only moment somebody definitely
is.

The escape hatch exists because a genuinely public sign-up is a real product,
and refusing it outright would just teach people to patch the check. What it
requires is that "open in production" be a sentence somebody wrote down.

Nothing else is accepted as consent. `yes`, `1`, `TRUE` and `on` all refuse —
those are what somebody types when they are guessing, and guessing is not
consent.

## Invitations

An invitation is a 24-character code drawn from a 32-symbol alphabet: 120 bits,
which is not guessable. `0`, `O`, `1` and `I` are excluded, because the failure
that actually happens is somebody retyping a code off a screen.

**The code is never stored.** What is stored is its SHA-256 and the first eight
characters as a fingerprint, so an administrator can pick an invitation out of a
list and say "that one". Eight characters cannot redeem anything; the entropy is
in the other sixteen.

The plaintext is returned exactly once, from the call that mints it. There is no
route that returns it again, because the platform does not have it. An
administrator who has lost a code mints another and revokes the first. This is
the contract the specification requires of any generated secret, and it applies
here for the same reason it applies to API keys: a system that can show you your
secret is a system that kept it.

### Redemption

```
POST /api/v1/admin/invites          mint one; the response carries the code, once
GET  /api/v1/admin/invites          list them by fingerprint
POST /api/v1/admin/invites/:id/revoke
```

All three require `invites.manage`, which only `ADMIN` holds.

A code is claimed in the same transaction that creates the user, by one
statement:

```sql
UPDATE invite_codes
   SET use_count = use_count + 1
 WHERE code_hash = $1
   AND revoked_at IS NULL
   AND expires_at > now()
   AND use_count < max_uses
RETURNING id
```

Two properties come from that being one statement rather than three:

**A single-use code cannot open two accounts**, even if two people redeem it in
the same millisecond. Reading the count, deciding, and writing it back would let
both through — which is how a single-use invitation quietly becomes a two-use
one under load. There is a test that runs both registrations concurrently and
asserts exactly one survives; it fails against the read-decide-write version.

**The claim and the user are atomic.** Claiming first and creating after would
spend an invitation on a registration that then failed. Creating first and
claiming after would let a spent code open a second account.

### Every failure says the same thing

Wrong, expired, revoked and spent all produce one message:

> That invitation code is not usable. Ask whoever invited you for a new one.

A distinct message for "expired" tells an outsider the code was real, which
turns the registration endpoint into an oracle for testing guesses.

### What the audit trail keeps

`INVITE_CODE_CREATED` and `INVITE_CODE_REVOKED` record the fingerprint, the
label, the use limit and the expiry. `USER_REGISTERED` records the registration
mode and, where there was one, the invitation's fingerprint — so "where did this
user come from?" is answerable six months later.

The code itself appears in none of them, and `invitecode` and `codehash` are in
the audit service's redaction list so that a future call site cannot put one
there by accident.

## Closed mode refuses before it looks

The mode check runs before the address is looked up.

That ordering is the whole of it. If a closed platform refused an unknown
address and behaved differently for a known one, it would be a free membership
oracle for anybody with a list of email addresses — and the register endpoint is
unauthenticated. There is a test that registers a known and an unknown address
against a closed platform and asserts the two errors are identical, code and
message both.

## Configuration

```
REGISTRATION_MODE=invite
REGISTRATION_ALLOW_OPEN_IN_PRODUCTION=false
INVITE_CODE_TTL_HOURS=168
```

## Smoke-testing a platform that is not open

`pnpm smoke` registers throwaway users to get tokens. A platform in `invite`
mode refuses them, and every check would then fail for a reason that has nothing
to do with what it is testing.

So mint a multi-use invitation first and pass it:

```
SMOKE_INVITE_CODE=<code> pnpm smoke -- --target https://your-host
```

Against an open platform the variable is unset and nothing changes. Verified
both ways: 14/14 checks pass in `open` mode with no code, and 14/14 in `invite`
mode with one.
