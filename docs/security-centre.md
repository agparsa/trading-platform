# The Security Centre

What a person can see about their own account's security, and where the
platform gets it from. All of it is on `/security` in the web app; all of it is
self-service, meaning a route a machine credential cannot reach.

| Panel                       | Route              | What it answers                                                                |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Two-factor authentication   | `/auth/2fa`        | Is a second factor on, and how many recovery codes are left                    |
| Sessions                    | `/auth/sessions`   | What is signed in as me _right now_, on what, from where — and end any of them |
| API keys                    | `/api-keys`        | What can act as me without signing in                                          |
| Where I have signed in from | `/auth/addresses`  | Have I ever been here?                                                         |
| Recent activity             | `/security/events` | What has happened to my account                                                |

## The address is real now

Everything above shows an address, and until this change every one of them
showed the **same** address: the stack's nginx container. Express resolves
`request.ip` from the socket, `trust proxy` is deliberately off (a blanket one
lets any caller name their own address), and behind two proxies the socket is
the inner proxy. So sessions all said `172.16.1.1`, the security feed said
`172.16.1.1`, and "signed in from a new device" compared one `172.16.1.1` with
another and never fired on an address.

The request middleware now resolves the caller **once** per request from the
forwarded chain, under `TRUSTED_PROXY_HOPS` — see [ip-rules.md](./ip-rules.md)
for the resolution and why unset and `0` differ — and attaches it as
`request.client`. Everything that records an address reads
`clientAddress(request)`; everything that _decides_ on one (the rate limiter,
an IP rule) reads `request.client.trusted` too, because for a decision the
honest answer to an untrusted address is "do not decide", not "use the socket".

A lint rule (`no-restricted-syntax` in `eslint.config.mjs`) refuses `request.ip`
anywhere else in the API. The rule exists because the mistake is invisible: code
that reads `request.ip` works perfectly in development, where there is no proxy,
and records nonsense in production, where nobody is looking at the column.

## Where I have signed in from

`GET /auth/addresses` groups the account's refresh-token rows by address: first
and last seen, how many sign-ins, what signed in from it (`describeDevice`, so
"Chrome on macOS" rather than a user-agent string), whether a session there is
still open, and whether it is the address the request is asking from.

**Grouped by address, not listed by session**, because the question a person
brings is "have I ever been here?" and the answer is a short list of places with
dates, not a long list of mornings. **Sign-ins are counted as rotation
families**, not token rows: a session refreshing every fifteen minutes for a
week is one sign-in, or the list is ninety-six mornings a day. The sessions
list says what is open now; this says where the account has _been_, for as long
as token rows are kept.

Two bounded queries: a `groupBy` for the dates, a `distinct` scan for the
clients. Neither reads every rotation row into memory.

## What is deliberately not here

- **A device list separate from sessions.** The spec lists "devices" beside
  "sessions". Here a device is what a session looks like — `describeDevice`
  reads the `User-Agent` and nothing else — and a separate registry would need a
  fingerprint to be a registry at all, which is the surveillance the sessions
  design refuses on purpose. The mobile app's push devices (`/devices`) are a
  different thing: delivery endpoints a person registers, not evidence of where
  they were.
- **A separate "own audit" beyond the security feed.** The feed _is_ the
  account's audit trail, projected: every row is derived from an audit row by
  `SECURITY_KINDS`, and a row not in that table is either not about the person
  or not their security business. A raw audit view would show a trader their
  own order events, which the blotter already does better.
- **A location.** An address is shown as an address. Geolocating it would put a
  city next to every row, be wrong often enough to be worrying, and require a
  lookup against a third-party database on every render.

## Tests

- `apps/api/src/common/request-context.test.ts` — the resolution, once, onto
  the request
- `apps/api/test/integration/sessions.test.ts` — "where the account has been
  signed in from"
- `scripts/pentest.ts` — the route is a person's, never a machine's
