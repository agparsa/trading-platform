# The penetration checklist

`pnpm pentest` boots the compiled API and **attempts** each attack below against
it. An attack that succeeds fails the run.

Two things this is not.

It is **not a claim that the platform is secure.** It is a record of specific
attacks that have been tried and refused. Everything not listed is untested, and
the honest reading of a green run is "these attacks failed" — never "there is
nothing to find". The script prints that sentence itself, so nobody quotes the
green line without it.

It is **not a scanner.** Every probe is written by hand against this API's own
semantics, because the interesting failures in a trading system are not the ones a
generic tool knows to look for: reaching another account's position, having a
rejected order still move money, replaying a one-time code. Those need somebody
who knows what the system is supposed to refuse.

## What is attempted

**Getting in without credentials**

- Reach `/accounts`, `/positions`, `/orders`, `/auth/sessions` with no token.
- Forge an access token signed with a guessed secret.
- Strip the signature with `alg: none`.
- Present the refresh token you were issued as an access token.
- Forge a token with the **real access secret** but the wrong `typ` (`refresh`,
  `2fa`, `session`, empty) — and present an access token as a sign-in challenge.
- Replay a refresh token that has already been rotated, and check the whole family
  is revoked rather than just that token.

**Reaching another account**

- Read another user's account, ledger, settings and state by id.
- Open a position on another user's account.
- Close another user's position.
- End another user's session.

**Becoming somebody more important**

- Put `role: ADMIN` in a profile update.
- Put `role: ADMIN` in a registration.
- Pollute `Object.prototype` through `__proto__` and `constructor.prototype` in a
  JSON body.

**Making the database do the work**

- SQL injection through the login email (`' OR '1'='1`, `'; DROP TABLE users; --`,
  a `UNION SELECT`), with a row count either side.
- SQL injection through a path parameter and a query string.

**Reading what should not be readable**

- Search ordinary responses for `passwordHash`, `totpSecret`, `tokenHash`,
  `refreshToken`, `$argon2`.
- Make the server describe its internals in an error: stack frames, `node_modules`,
  `PrismaClient`, `SELECT`, a connection string, a filesystem path.
- Read the server and framework version from response headers, and confirm the
  security headers are present.

**Trading logic**

- Open a position with a negative, zero, `NaN`, `Infinity` or absurd volume — and
  confirm the balance did not move on the rejections.
- Reuse an idempotency key with a different order body.

**Grinding**

- Guess a password repeatedly until the account locks, then confirm the _correct_
  password is also refused while locked. A lockout that lets the right password
  through only delays a guesser.

## The checklist was itself tested by breaking the system

A checklist that passes on its first run has proved nothing. Four deliberate
regressions were introduced into the API to see whether the probes noticed:

| Regression                                           | Caught?           |
| ---------------------------------------------------- | ----------------- |
| Account access stops checking who owns the account   | Yes — four probes |
| The failed-login lockout raised out of reach         | Yes               |
| The access-token `typ` check removed                 | **No, at first**  |
| The unhandled-error branch returns `exception.stack` | **No**            |

The two misses were the useful part.

**The `typ` probe was passing for the wrong reason.** It presented the refresh
token as issued — which is signed with the _refresh_ secret, so it fails on the
signature and never reaches the type check at all. The probe proved the two
secrets differ, which was not what it claimed. It now signs a token with the real
access secret and the wrong `typ`, modelling the exact situation the check exists
for: an access secret that has leaked. With that change the regression is caught.

**The stack-trace branch cannot be reached from outside.** Every error a client
can provoke is a _handled_ one — a 404, a validation failure, malformed JSON —
and each takes an earlier path through the filter. The unexpected-exception branch
is the only one holding a real stack, and nothing in the entire suite would have
noticed it being served to clients. That is now a unit test
(`domain-exception.filter.test.ts`), where the exception can be thrown at the
filter directly: the response must be `INTERNAL_ERROR` plus a request id, must
contain no stack, message or path, and must be byte-identical whatever was thrown
— so the shape reveals nothing either.

A probe that has never been seen to fail is a probe nobody has checked.

## What is deliberately not here

- **Denial of service.** Load and capacity are measured by `pnpm load`, and
  attacking availability on a shared container measures the container.
- **Transport.** TLS terminates at the proxy; there is nothing to test in this
  process.
- **The WebSocket.** Its isolation is covered by `pnpm smoke:ws`, which asserts
  that one account's private frames never reach another socket and that a private
  channel is refused without a token. Duplicating that here would create a second
  definition of the same check.
- **Dependency vulnerabilities.** `pnpm audit` belongs in CI, not in a script that
  boots the API.
