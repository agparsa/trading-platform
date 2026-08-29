# Sessions, devices and the new-device notice

A user with a stolen password has one question: _is somebody else signed in as
me?_ Before this, the platform held everything needed to answer it — every
refresh token has carried a user agent and an IP since the first migration — and
offered no way to ask.

## A session is a rotation family, not a token row

An access token lasts fifteen minutes, so a browser left open all day rotates its
refresh token about ninety-six times. Each rotation writes a row. A list built
from rows would show one laptop as ninety-six sessions.

So the unit is the **family**: one sign-in, however many times its token has since
rotated. That is also what a person means by "session", and it is what the revoke
endpoint ends.

## Liveness and history are two different questions

Rotation revokes the row it replaces, so the live rows are only ever the _newest_
token of each family. A list built from those alone reports every session as
having begun at the last refresh — a laptop signed in on Monday and still open on
Friday would say "signed in fifteen minutes ago", which is exactly the fact the
user opened the list to check.

`SessionsService.list` therefore runs two queries: the live rows say which
sessions exist and what they look like _now_, and a grouped `min(created_at)` over
each whole family says when each one _began_.

This was found by a test asserting the timestamps against the rows, not by reading
the code.

## Which session is this one

`AccessTokenClaims` carries `fam`, the same rotation family the refresh token
carries. Without it, a user looking at their sessions cannot tell which row is the
browser they are reading it in — and revoking the wrong one signs them out while
leaving the intruder in place.

## What is deliberately not collected

Per §30, and worth stating plainly. The only inputs are:

- the `User-Agent` header the browser already sends, and
- the IP the connection already arrived from.

No canvas fingerprint, no font enumeration, no screen metrics, no cross-site
identifier, no geolocation lookup, no correlation with anything outside the
`refresh_tokens` table.

That is a real accuracy cost and the right trade. The question a person is
answering is "is one of these not me", and "Firefox on Windows, 203.0.113.4, since
Tuesday" answers it. A device hash would be more unique and would answer nothing —
a user cannot look at a hash and recognise their own laptop.

A user agent is self-reported and trivially forged. That is acceptable here
because nothing in this file _grants_ anything. It informs a person; it never
decides.

## The new-device notice

Keyed on the device **signature** — browser and system, no version — and
deliberately not on the IP:

- An IP changes when a phone moves between cells. Alerting on it would produce
  several notices a day for an ordinary commuter, and a notice that arrives
  several times a day is not read on the day it matters.
- A browser version changes every few weeks by itself. Same argument.

The first ever sign-in says nothing: there is no norm to be new against, and
"welcome, this device is unrecognised" is noise on the account's first minute.

The email names the device and a **coarse** IP — `198.51.100.x`, not the full
address. Enough to recognise, not enough to place, in a message that may itself be
read by somebody else. The full value stays in the session row for an
investigation that needs it.

It also says what to do: change the password, end the session, turn on two-factor
authentication.

The notice is sent **after** the session is issued, and it can never fail the
sign-in. A mail server being down is not a reason to lock a trader out of their
positions. The failure is logged.

## Revoking

`DELETE /auth/sessions/:id` is scoped by user id inside the query that finds the
session, so a family belonging to somebody else is _not found_ rather than found
and refused. The two are indistinguishable from outside, which is the point.

A user ending their own current session is signing out. That is a reasonable thing
to want from a list of sessions, so it is allowed rather than blocked; the cookie
is left alone and the next refresh fails, which is the same path an expired
session takes.

## A defect this surfaced

The shared HTTP client read every response body as JSON. A `204 No Content` has no
body by definition, so `response.json()` threw and the client reported "the server
returned an unreadable response" — _after the server had done the thing_.

Every 204 endpoint was affected: sign out, disable two-factor, end a session. It
had gone unnoticed because the only caller that existed, sign-out, swallowed its
errors. Found by clicking "End" in a browser and watching the row stay.
