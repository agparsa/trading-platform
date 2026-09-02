# API keys and service tokens

Bearer credentials that are not sessions. The surface a script, a spreadsheet
or another product uses to reach the platform without a browser — and the
surface a future PropFA product would consume, which makes its shape a
boundary decision rather than a convenience.

## The rule

From the specification, without exception: **never store the raw secret; hash
it; store a fingerprint for identification; show the generated secret exactly
once.** A platform that can show a user their existing API key is a platform
that stored it.

So a credential looks like this:

```
tpk_h7Qm3xL2pA9k_<43 characters of secret>
└┬┘ └────┬─────┘ └──────────┬──────────┘
kind   handle           the secret
```

The **fingerprint** (`tpk_<handle>`) is the credential's public name. It is
stored in the clear, unique, and is what the row is looked up by — so
authenticating is one indexed read and one constant-time comparison, never a
scan of every hash. It is what lists, audit rows and notifications show.

The **secret** is 32 random bytes. It is never stored; its SHA-256 is.
Unsalted, deliberately: a salt defends a low-entropy input against
precomputation, and 256 random bits are not one. A copy of the table gives an
attacker nothing to present.

The **kind** — `tpk_` for a person's key, `tps_` for the firm's token — is
what lets the guard tell a credential from a session JWT (which begins `eyJ`)
before anything is looked up, and what lets a secret scanner recognise one in a
repository.

`mintCredential` in `@tp/crypto-core` is the only place a secret exists in the
clear; the minting endpoint hands it back once and forgets it. A holder who has
lost one mints another.

## Two kinds, two rules

### An API key is a person's

It acts as them — the request carries their id, their audit rows name them —
within a subset of their capabilities **fixed at minting** and **intersected
with their current ones on every use**. A person moved from USER to SUPPORT
finds every key they hold can no longer place an order, without anybody
revoking anything.

What may be in the subset is `KEYABLE_PERMISSIONS`: everything a person may
hold except the acts that must be a person's, listed in `PERSON_ONLY_PERMISSIONS`
with the reason for each:

| A key may never…                                                                                        | because                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| adjust a ledger or a wallet, confirm a deposit, start one, ask for or approve a withdrawal              | a leaked key must not be able to make money appear or drain a wallet to a new destination |
| assign roles, edit roles, manage users, mint invitations                                                | it changes who may do what                                                                |
| mint, list or revoke keys or service tokens                                                             | a key that can mint keys is a key that never expires                                      |
| open identity documents, submit them, decide them                                                       | an act the platform records as a person's                                                 |
| halt trading, change an instrument's terms, manage master links, integrity, reconciliation, risk policy | the same                                                                                  |

Trading, reading one's own accounts, wallet and history, and every `*_read_any`
a staff member holds are all keyable. A trading bot gets `orders.create`,
`orders.cancel`, `positions.read`, `accounts.read`; a monitoring integration
run by a risk manager gets `accounts.read_any` and `risk.read`.

Minting asks for the **password again**, as changing it does. A session left
open on a shared screen must not be able to turn itself into a secret that
outlives it.

### A service token is the firm's

It carries **reads across the tenant, and nothing else** —
`SERVICE_GRANTABLE_PERMISSIONS`. Every write on this platform is audited
against the person who made it, and the audit log has no way to say "an
integration did this": an actor column that is a user id or nothing. Until it
has one, a machine may look and may not touch. And the routes it may look at
are the ones that read across accounts rather than "mine", because a token has
no "mine".

It may carry only what its **minter holds**, so nobody mints a token that can
do more than they can — the same rule that bounds editing a role. Only ADMIN
holds `service_tokens.manage`.

The gap is stated rather than filled: an integration that suspends accounts or
places orders on a person's behalf needs a service actor in the audit model
first. That is the next step for this surface, not a missing checkbox.

## What a credential reaches

The auth guard turns a presented credential into a principal; the permission
guard then applies two rules a session never meets:

- **Only routes that name a capability.** A route that declares nothing is a
  person's — a profile, a notification list, a preference — and a key holding
  `positions.read` has no business reading its holder's inbox. Every
  `_authenticated only_` row in `API_INVENTORY.md` is closed to credentials.
- **Never a `@SelfService()` or `@SessionOnly()` route.** Changing a password,
  enrolling a second factor, ending sessions, and everything under `/api-keys`
  and `/admin/service-tokens` need the person. A stolen key cannot change what
  authenticates its holder, and cannot breed.

The WebSocket accepts sessions only. A realtime feed for an integration is a
later phase, and it will arrive with the service actor above.

## Every use

One indexed read by fingerprint, one constant-time comparison, one read of the
holder, one Redis increment. Then, off the request's path:

- a **daily counter** per credential — requests, capability refusals,
  throttles — which is what "is this key still used" and "is something
  hammering us with it" are answered from, without a row per request;
- the credential's **last use and address**, stamped at most once a minute.

Both are written after the response; `CredentialsService.drain()` waits for
them, and shutdown does.

## Limits

| Variable                        | Default | Rule                                                                    |
| ------------------------------- | ------- | ----------------------------------------------------------------------- |
| `API_KEY_MAX_TTL_DAYS`          | `365`   | the longest a credential may live; a person may choose shorter          |
| `API_KEY_DEFAULT_TTL_DAYS`      | `90`    | what a person gets without choosing                                     |
| `API_KEY_MAX_PER_USER`          | `10`    | live keys one person may hold; revoked and expired do not count         |
| `API_KEY_RATE_LIMIT_PER_MINUTE` | `300`   | per credential, on top of the per-address limit; a key may choose lower |

The per-credential limit is a fixed window in Redis. If Redis cannot answer,
the request is allowed and the failure logged: the per-address limit still
stands, and refusing every valid client for a cache blip is the worse failure.

## Revocation

Immediate, and not reversible. The holder revokes their own from the Security
page; anyone holding `api_keys.revoke_any` (risk management, administration)
revokes anyone's from `/admin/credentials`, with a reason the holder is told.
A revoked credential stays in the list and in the table: a deleted key is a gap
where an audit row points, so the database refuses to delete one. Minting and
revoking are both notified to the holder whatever their preferences — the first
is how they learn of a key they did not mint.

## At the database

`api_keys` and `service_tokens` carry row-level security like every other
tenant-scoped table, and two triggers each: what was minted is fixed — holder,
fingerprint, hash, permissions, expiry — so a key whose permissions could be
widened afterwards cannot exist, and only the display name, use and revocation
move; and rows are never deleted. `credential_usage` is one row per credential
per day.

## Verified by breaking it

Twenty integration tests drive the service with a real database and a Redis
that the test controls, including dying; fifteen unit tests drive the
permission guard with a real `Reflector` over a really-decorated class. Each
guarantee was then removed and the tests watched: the secret not compared, the
key not bounded by the holder's current role, the rate limit off, service
tokens allowed any held capability, keys allowed person-only ones — each
caught. Dropping the explicit tenant check survived, because the tenancy
extension does not find the row either; the check stays as the second layer
it is.

The smoke suite mints a key over HTTP, uses it, is refused with it, and revokes
it, because the guard that does all of this is global and only a booted
application has one. Two pentest probes try to do more with a stolen key than
it was minted for, and to mint a service token that trades.
