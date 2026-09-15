# Break-glass (§9)

A member of staff, temporarily seeing what one trader sees.

## Why a grant and not a token

The obvious design is to mint an access token that says "you are the trader". It
is the wrong one, for three reasons that only show up later:

- Every downstream check would see the trader, so nothing could distinguish a
  supervised look from the customer's own session.
- The audit trail would name the **trader** as the actor. The one thing an
  investigation needs from a break-glass record is who actually did it.
- Revoking mid-session would mean chasing a token that has already been issued.

So the staff member stays themselves for the whole session and carries a row
instead. Revocation is an `UPDATE`. The audit trail always names the person who
did it. And "may this person see that person's data" is asked **per request**
against the database's clock, rather than minted into a claim and trusted for
the next fifteen minutes.

## How a request carries one

An `x-break-glass: <grantId>` header, on every request that wants it.

Opt-in per request, and that is the point: a staff member browsing normally
cannot accidentally be looking at somebody else's data, because looking at
somebody else's data takes an explicit act every single time.

A grant that is expired, ended, or somebody else's resolves to nothing and the
request proceeds as the staff member. That degradation is deliberate — a stale
grant id in a browser tab should show the operator their own screen, not a wall
of errors.

## The refusals

| Refused                                           | Because                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Presenting a grant without `security.break_glass` | A caller whose permission was taken away must be told, not quietly served their own view while believing they see somebody else's.          |
| **Any non-GET request carrying a grant**          | The one check that makes "read-only" a property of the system rather than a hope about which routes were remembered.                        |
| A grant on an API key or service token            | A long-lived secret in a config file has no eyes and cannot be asked why it looked. **This table said so before the code did** — see below. |
| A subject in another tenant                       | A broker's staff cannot reach the platform's users or another firm's traders. Refused by the service and again by row-level security.       |
| A subject with staff powers the actor lacks       | Otherwise support tooling is a route to reading the platform through a super administrator's eyes.                                          |
| Breaking glass on yourself                        | Always either a mistake or an attempt to make an ordinary action look supervised.                                                           |
| A reason under eight characters                   | Enforced by a database CHECK as well as the API.                                                                                            |

### "Upward" means staff powers, not any difference

The first version of the escalation rule refused every trader, and was right to
fail: an administrator **deliberately cannot place an order**, so a plain trader
holds permissions the administrator does not. Those are a separation of duties,
not seniority, and comparing raw permission sets mistakes one for the other.

So the baseline every ordinary user holds is subtracted first, and what remains
is what the subject can do _as staff_. That is the comparison.

## Who holds the permission

`security.break_glass` sits on the tenant's **ADMIN**, and deliberately **not**
on SUPPORT.

Support is who needs it day to day, which is exactly the argument for not giving
it to them by default: "anyone on the support rota can look through any
customer's eyes" is a different security posture from "a named senior person
can, with a reason, for an hour". A firm that wants the first should decide it
on purpose.

It is on the _tenant's_ administrator rather than the platform's because a grant
cannot cross tenants — a platform-only permission would be useless for the case
it exists for, which is a broker supporting its own trader.

## Time

`BREAK_GLASS_MAX_TTL_MS`, one hour by default, capped rather than refused. A
grant is an errand, not a mode somebody leaves switched on: long enough to work
through a customer's problem with them on the phone, short enough that a
forgotten one closes itself before the end of the shift. Asking for longer is
silently capped — the person is mid-incident and does not need an argument about
a number.

There is deliberately **no route that extends a grant**. A session that needs
longer is a new grant with a new reason, which is one more line in the review
list rather than one grant that quietly never ends.

## The subject is told

`BREAK_GLASS_OPENED` lands in the **account owner's** security feed, at
`WARNING`. Somebody looked at your account is a thing you are entitled to know,
and a break-glass nobody outside the room can see is indistinguishable from
snooping.

It is recorded against the subject even though they did not cause it: the feed
answers "what happened to my account", not "what did I do".

## Review

`GET /security/break-glass` lists every grant in the firm, and requires
`system.operations` rather than `security.break_glass` — the person who reviews
break-glass use should not have to be somebody who can perform it. A feature
nobody reviews is a back door with paperwork.

Each row carries the reason in full, who, whose, when, and `uses`. Zero uses
means a grant was opened and never used, which is worth being able to see.

## Which routes honour a grant

A closed list, and short: a trader's own accounts, settings and ledger; their
orders, pending orders, order events, positions and trades; and one account's
live state. Each resolves its subject with `subjectOf(user)` rather than
`user.id`.

Every other route ignores the grant entirely and serves the staff member's own
view. That is the safe default: a route that _forgets_ `subjectOf` is wrong but
harmless, while a route that reached for the subject without checking would be
the other kind of wrong.

## Not built, and why

**`READ_WRITE`.** The enum has the value because §9 describes it, and truncating
the vocabulary at the database boundary is how a column quietly becomes a lie.
The service refuses to create one and the guard would refuse the request anyway.

A support person placing a trade as a customer needs controls a firm has to
decide on — who approves it, for how long, what remains forbidden even then, and
how the customer is told. Inventing those here would be inventing a policy
nobody agreed to.

## What the gate was not catching

The refusals above are three `if`s in one guard. In September 2026 each was
removed in turn from a compiled build and the sixty-two-attack penetration suite
run against it. **The read-only rule — the one this document calls "the one
check that makes read-only a property of the system rather than a hope" — was
removed and every attack still passed.**

The probe existed. It posted an order carrying a grant header and asserted a 403. An administrator **cannot place an order at all**, so that request answers
403 whether or not break-glass is read-only, and the assertion could not tell
the two apart. Its companion check deleted `/accounts/:id`, a route with no
DELETE handler, and accepted `403 || 404` — the 404 came from routing, before
any guard ran.

Both now use a route the administrator _may_ use — opening and closing a grant —
and compare the answer with and without the header, so the difference is
attributable to the grant and nothing else. The refusal message is asserted too,
because any 403 would otherwise do.

The same exercise found that the row above was **aspirational**: the credential
branch of the guard returned before a grant was ever examined, so an API key
presenting `x-break-glass` was served a cheerful 200 full of its own data. No
escalation in it — and wrong in the way this guard already argues against one
bullet earlier: somebody who cannot use a grant must be **told**, not quietly
served their own view while believing they are seeing somebody else's. It
refuses now, and an attack covers it.

Removing any of the three fails the suite today. That is the claim this section
is willing to make; it was not true a day ago.
