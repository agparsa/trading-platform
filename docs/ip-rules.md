# Where the firm may be reached from

Per-tenant IP rules (§46). A firm can say which addresses its staff — and, if it
chooses, its customers — may reach the platform from.

The feature is small. Almost all of it is about one failure.

## The failure

An allow-list that excludes the person who wrote it locks the firm out of the
screen where the mistake could be undone. The only remaining fix is a database
console, which is not a support process — it is an outage, at a firm that was
trying to improve its security.

So, in order:

1. **A rule that would shut out its own author is refused**, evaluated against
   the whole rule set as it would be after the write — not against the new rule
   alone. An `ALLOW` covering your own address is still a lock-out if an
   existing `DENY` covers it too.
2. **Rules are refused until the deployment says what sits in front of it.** A
   rule enforced against an nginx container's address admits everybody or
   excludes everybody.
3. **Disabling and deleting are never refused.** Whatever state a firm has
   reached, the way _out_ stays open.
4. **The guard fails open** when it cannot establish the caller's address, and
   says so once per process at `error` level. A control that is off and looks on
   is worse than one that is plainly off.

## Configuration

`TRUSTED_PROXY_HOPS` — how many proxies at the right-hand end of the
`X-Forwarded-For` chain were appended by infrastructure this deployment owns.

| Value   | Meaning                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| _unset_ | Nobody has said. The socket address may be a client or a proxy; it is reported for logs and **not trusted**, and no rule is enforced. |
| `0`     | A claim: nothing sits in front of this API. The socket address is the client, and the forwarded header is ignored entirely.           |
| `n`     | `n` owned proxies append to the chain. The client is the entry immediately to their left.                                             |

Unset and `0` are deliberately different. Collapsing them would mean either
refusing every directly-exposed deployment the feature, or silently enforcing an
allow-list against a proxy's address. There is no safe default for a value only
the operator can know, so there is no default.

**This deployment sets `2`**: a host nginx holding 80/443, and the stack's own
nginx container.

### Why the header is not simply trusted

`X-Forwarded-For` is a header. Anyone can send one. A caller may prepend
anything they like; they cannot make their forgery land in the trusted position,
because each real proxy appends after it. A chain shorter than the configuration
promised is not a basis for a decision either — falling back to another entry
would let a caller who sends a short header choose which entry is believed — so
the address is reported and marked untrusted.

### The same address decides the rate limit

`@nestjs/throttler` buckets by `req.ip`, and Express does not resolve that from
the forwarded chain unless `trust proxy` is set — which it deliberately is not,
because a blanket `trust proxy` lets any caller name their own address. So
behind nginx the whole platform shared **one** rate-limit bucket: one noisy
client exhausted the allowance for every customer, and an attacker got the same
allowance as the entire legitimate population combined.

The throttler now takes its bucket from the same `resolveClientIp`, via
`common/throttler-tracker.ts`. One definition of "who is calling" for the whole
application, rather than two that can drift. When the address cannot be trusted
it falls back to the socket address, which is what the library used before, so
the limiter is never worse than it was.

Note that nginx's own `limit_req_zone $binary_remote_addr` has the same
property one layer out: at the stack's nginx that variable is the _host_
nginx's address unless `real_ip` is configured, so those zones share a bucket
too. `TRUSTED_PROXIES_FILE` in `.env.production.example` is where that is fixed;
it is a deployment decision, not an application one.

## How a rule is evaluated

Rules have a `kind` (`ALLOW` / `DENY`) and a `scope` (`STAFF` / `EVERYONE`).
Only rules matching the caller's scope are considered; `EVERYONE` rules are
applied to customers, `STAFF` rules to everyone else.

1. Any matching `DENY` refuses. Denial beats everything.
2. If any enabled `ALLOW` exists in that scope, the set is in **allow-list
   mode**: an address not covered by one is refused.
3. Otherwise the address is allowed.

So a set with no `ALLOW` rules is a deny-list, and adding the first `ALLOW`
switches the whole scope to an allow-list — which the admin screen warns about
before the button is pressed, because it is the change with the largest blast
radius in the feature.

Addresses are matched by CIDR, IPv4 and IPv6, with `::ffff:` v4-mapped addresses
unmapped first. A rule never matches across families. A rule the platform cannot
parse is ignored rather than treated as matching.

## Where it is enforced

`IpRulesGuard`, registered globally in `AppModule` **after** `BearerAuthGuard`
and **before** the role and permission guards:

- After authentication, because the rule set is per tenant and the scope depends
  on whether the caller is staff.
- Before authorization, so a caller from a refused address is turned away without
  the platform revealing whether they would otherwise have been allowed in.

Public routes and unauthenticated requests are never refused. The sign-in page
has to stay reachable, or a misconfigured allow-list leaves nobody able to get in
and fix it.

The refusal names the caller's own address and nothing about the rules. Somebody
kept out does not get to map the allow-list by probing it; somebody legitimately
locked out needs exactly one fact to tell their administrator.

## The API

All routes are `@SessionOnly()` and require `system.operations`. A long-lived key
in a config file must not be able to rewrite who can reach the platform — that is
the one change a stolen credential would most want to make.

| Route                                 | What it does                                                          |
| ------------------------------------- | --------------------------------------------------------------------- |
| `GET /security/ip-rules`              | The rules, plus `yourAddress`, `yourAddressTrusted` and `enforceable` |
| `POST /security/ip-rules`             | Add one. Refused if it would shut you out                             |
| `POST /security/ip-rules/:id/enabled` | Turn one on or off. Off is never refused                              |
| `DELETE /security/ip-rules/:id`       | Remove one. Never refused                                             |

`GET` reports the caller's own address because the first question anybody
writing an allow-list has is "what am I coming from?", and making them guess is
how they write one that excludes themselves.

## Audit

Every change writes an audit row (`IP_RULE_CREATED`, `IP_RULE_ENABLED`,
`IP_RULE_DISABLED`, `IP_RULE_DELETED`) and a `IP_RULE_CHANGED` security event at
`WARNING`, in the feed of the person **whose session made the change** — unlike
break-glass, which is recorded against its subject. An IP rule has no individual
subject; it is a firm-wide control. Recording it against the actor is what makes
it useful: an attacker holding a staff session widens the allow-list to cover
their own address, and the rightful holder of that session is the one person
certain to see a change they did not make. Removal is `WARNING` too — a rule
taken away is a control weakened, which is what an attacker does second.

## Tests

- `apps/api/src/security/ip-rules.test.ts` — parsing and evaluation
- `apps/api/src/security/client-ip.test.ts` — resolving the caller's address
- `apps/api/src/security/ip-rules.guard.test.ts` — the guard's own decisions
- `apps/api/test/integration/ip-rules.test.ts` — refusals, tenancy, audit
- `scripts/pentest.ts` — the routes over HTTP, and the forged-header attack
