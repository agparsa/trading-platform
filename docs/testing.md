# Testing

This is a financial system. Tests are not a quality gate bolted on afterwards;
the formulas were written against them.

```
pnpm test              # 761 tests (integration ones opt-in)
pnpm db:test:prepare   # create + migrate the integration test database, and its roles
pnpm db:roles          # create the unprivileged role row-level security constrains
pnpm test:coverage     # thresholds enforced
pnpm verify            # lint → typecheck → test → build
pnpm check:schema      # no floating-point columns exist
pnpm smoke             # boots the built API and drives a full trade round trip
pnpm smoke:ws          # boots it again and drives a real Socket.IO client
pnpm smoke:web         # boots the API and the web app and opens every screen
pnpm pentest           # boots it again and attacks it
pnpm soak              # boots it again and leaves it running
pnpm restore:rehearse  # dumps it, restores it elsewhere, compares the two
```

Integration tests run against a real PostgreSQL database named by
`TEST_DATABASE_URL`, and skip themselves when it is unset — so a clean checkout
gets a green `pnpm verify` with no extra setup, and `pnpm test` still works
offline. Enable them with `pnpm db:test:prepare`, which creates and migrates a
separate database and prints the line to uncomment in `.env`. They use a real database on purpose: row locks, unique
constraints and transaction boundaries are exactly what they check, and a mocked
`FOR UPDATE` proves nothing.

`rls-enforcement.test.ts` needs one thing more: `TEST_DATABASE_URL_TENANT`, a
connection as the unprivileged role, because PostgreSQL exempts a table's owner
from its own policies and a test run as the owner would prove nothing while
passing. `pnpm db:test:prepare` creates that role and prints the line. Without
it the file skips — and a skipped proof of tenant isolation reads exactly like a
passing one in the summary.

## What is covered today

| Area                   | Tests | Highlights                                                                               |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------- |
| Decimal & rounding     | 13    | `0.1 + 0.2` exactness, grid quantization, non-integer JS numbers rejected                |
| Money                  | 9     | Currency mixing refused, JPY minor units, 100 × 0.01 = 1.00 exactly                      |
| Instruments            | 11    | Spec validation, tick/lot normalisation, reference exposure figure                       |
| P&L                    | 22    | Executable-side selection, **eight reference-terminal vectors**, FX conversion           |
| Margin                 | 7     | Instrument rate as a floor, reference margin figure, sizing to free margin               |
| Account state          | 8     | Reference snapshot, `marginLevel` vs `marginUtilization`, null-not-infinite              |
| Order state machine    | 8     | Terminal dead ends, fill-wins-cancel race, modify rollback                               |
| Position state machine | 4     | `CLOSING` guard, double-close refused                                                    |
| Protective orders      | 20    | Wrong-side rejection, bid/ask trigger sides, ambiguous tick resolution, trailing ratchet |
| Risk engine            | 12    | Unset limit = no limit, exact-margin allowed, all violations reported                    |
| Market core            | 34    | Seed determinism, candle bucketing, staleness, script replay                             |
| API client             | 8     | Envelope unwrap, error codes, idempotency header, token refresh                          |
| API config & errors    | 15    | Boot refused on weak secrets, every error code has a status                              |
| Worker                 | 6     | Queue names unique, failed jobs retained                                                 |
| WS subscriptions       | 8     | Candle symbol/resolution filters, chart never narrows the quote stream, gapless `seq`    |
| Terminal logic         | 28    | Ticket validation shares the engine's rules, cost estimates, bar windows, live-bar merge |
| Charting adapter       | 18    | Seconds-vs-milliseconds, price scales, session renumbering, exclusive `to`, countBack    |

## Reference vectors

The P&L, margin and account tests assert against numbers captured from a live
broker terminal rather than from our own expectations. Eight independent figures
reproduce exactly — see [pnl.md](./pnl.md). Anchoring the arithmetic to observed
production behaviour is what makes a bug in a formula fail a test instead of
becoming the definition of correct.

The one place the reference terminal and this platform deliberately differ is the
"Margin Level" label, which the terminal computes as utilisation. Both are
implemented under unambiguous names.

## Deterministic market script

Tests never use `Math.random()` or the wall clock. `ScriptedMarketDataProvider`
plays an exact tick list:

```
XAUUSD  bid 4500.00  ask 4500.20
        bid 4501.00  ask 4501.20
        bid 4502.00  ask 4502.20
```

The same sequence must produce the same fills and the same P&L, on any machine,
forever. `ManualClock` and `SeededRandom` cover the other two sources of
nondeterminism.

## Verification by breaking it

A guard nobody has watched fail is a guard nobody knows works. Each of these was
deliberately broken and the named test confirmed to fail before being restored:

| Guard                              | Broken by                                | Result                           |
| ---------------------------------- | ---------------------------------------- | -------------------------------- |
| Ledger row lock                    | removing `FOR UPDATE`                    | 10 deposits produced 1200        |
| Close claim (`OPEN → CLOSING`)     | removing the state guard                 | duplicate trade rows             |
| WebSocket account filter           | removing one `if`                        | Bob received Alice's frames      |
| Candle/quote filter separation     | sharing one symbol set                   | watchlist stopped updating       |
| Candle subscription replacement    | accumulating instead of replacing        | four streams for one chart       |
| Entry-commission apportionment     | dividing by remaining instead of initial | 12.10 charged where 7.00 was     |
| Round-trip `netPnl`                | dropping the entry leg                   | report no longer matched balance |
| Single entry-commission posting    | re-posting the entry leg at close        | 21.00 charged where 14.00 was    |
| Permission guard refusal           | short-circuiting the role check          | 5 of 8 guard tests failed        |
| Permission metadata key            | renaming it in the decorator only        | 6 of 8 guard tests failed        |
| Permission `and` semantics         | `every` becoming `some`                  | catalogue and guard tests failed |
| Global guard registration          | deleting the `APP_GUARD` provider        | coverage test failed             |
| Account ownership check            | removing it from the resolver            | 5 of 7 isolation tests failed    |
| One refusal for "not yours"        | giving it its own error code             | 3 of 7 failed                    |
| Resolver's caller transaction      | ignoring the client it was handed        | 1 of 7 failed                    |
| A service calling the resolver     | dropping the call in `positions.list`    | 1 of 7 failed                    |
| Master link's owning master        | not checking whose link it is            | 2 of 12 master tests failed      |
| Link revocation                    | dropping the status predicate            | 2 of 12 failed                   |
| Delegation ceiling, on read        | trusting the stored capability list      | 1 of 12 failed                   |
| Delegation ceiling, on grant       | accepting any capability                 | 1 of 12 failed                   |
| Socket's link filter               | not checking whose link it is            | 1 of 12 failed _(see below)_     |
| Socket's revocation filter         | dropping the status predicate            | 1 of 12 failed                   |
| Ledger rounds once                 | rounding amount and balance separately   | the sub-cent ledger test failed  |
| Trading day's DST correction       | assuming every day is 1440 minutes long  | 2 of 4 day-boundary tests failed |
| Account view merge                 | taking the live frame whole              | realized P&L read "—"            |
| Trade components rounded once      | deriving `net` from unrounded terms      | 2 of 12 figure tests failed      |
| Final close absorbs the residue    | giving it its own proportion instead     | 1 of 12 failed                   |
| Every trade reaches the ledger     | skipping the entry when it rounds to 0   | 1 of 12 failed                   |
| Chart drop uses the engine rule    | skipping `validateProtectiveLevels`      | 3 of 18 chart-level tests failed |
| One level per modification         | naming both, with `null` for the other   | 2 of 18 failed                   |
| Entry line is not draggable        | marking it draggable                     | 1 of 18 failed                   |
| Levels belong to one instrument    | dropping the symbol filter               | 1 of 18 failed                   |
| Chart drop snaps to the tick       | `toFixed` instead of `normalizePrice`    | 1 of 18 failed _(see below)_     |
| Shortcuts stay out of fields       | dropping the text-entry check            | 1 of 22 shortcut tests failed    |
| Modifiers cancel a shortcut        | ignoring ctrl/meta/alt                   | 1 of 22 failed                   |
| Close-all always confirms          | letting it follow the preference         | 1 of 22 failed                   |
| Stored preferences are checked     | spreading them over the defaults         | 5 of 22 failed                   |
| Confirmation defaults on           | requiring an explicit `true`             | 2 of 22 failed                   |
| Reconciliation records findings    | computing them and persisting none       | 2 of 38 failed                   |
| Open-position costs added back     | comparing without them                   | 4 of 38 failed                   |
| Resting orders are not faults      | flagging any order with no execution     | 3 of 38 failed                   |
| Execution side nets volume         | summing every execution as an opening    | 1 of 38 failed _(see below)_     |
| Volume norm needs a sample         | comparing against a one-order history    | 1 of 29 integrity tests failed   |
| Median, not mean, for the norm     | averaging instead                        | 2 of 29 failed                   |
| Concentration needs an alternative | counting a single position               | 1 of 29 failed                   |
| Densest window for a burst         | a fixed last window                      | 1 of 29 failed                   |
| A recurrence is not a new signal   | inserting a row each time                | 3 of 9 failed                    |
| A dismissal is not overruled       | reopening on recurrence                  | 1 of 9 failed                    |
| Signal history is append-only      | replacing events on a status change      | 1 of 9 failed                    |
| Realized P&L carried per account   | carrying it across a change of account   | 1 store test failed              |

Three of those are worth remembering.

Emptying the permission guard left every one of the 205 API tests passing,
because the catalogue was tested in isolation and the route declarations were
tested as text, and nothing exercised the thing in between. Deleting its
registration left the suite green for the same reason.

The socket's link filter **survived** its first mutation. The test asserted that
an unlinked account was not streamed — but the only link in the database belonged
to the operator under test, so a gateway that had stopped asking _whose_ link it
was still produced the right set. The fix was to the test: put another operator's
delegation in the same table, and the assertion starts meaning what it says. The
defect it would have hidden is every socket receiving every delegated account's
private frames. A mutation that survives is the useful kind — it names a test
that was agreeing with the code rather than checking it.

Reconciliation's netting **survived** too, and its story is the plainest of the
three: every fixture in the worker suite opened a position and none had ever
closed one, so summing every execution and netting them by side gave the same
answer. A position closed halfway now exists in the suite.

Its very first run against those fixtures also reported two critical findings on
an account the previous engine called clean — correctly. The swap tests created
positions directly in the database with no order and no execution behind them, a
shape no code path can produce. The fixture was fixed, not the check.

Tick snapping **survived** its first mutation, for the same reason the socket's
link filter did: the test could not tell the two behaviours apart. Gold trades in
one-cent ticks and quotes two decimals, so `normalizePrice` and `toFixed(2)`
agree on every input. The test now uses an instrument trading in five-cent ticks
at two decimals, where they disagree — and the mutation fails. Both survivals
came from a fixture that made the wrong answer look like the right one.

The ledger's double-rounding was not found by a mutation at all. It was found by
opening the terminal in a browser, noticing that "Realized today" read "—" when
the API had plainly sent a figure, and then — while checking the number that
_did_ appear — reading a real account's ledger entries down the page and seeing
that they did not add up to the balance printed beside them. Two defects from
one screenshot, neither reachable from the test suite as it stood: the seeded
test instruments charge no commission, so no test had ever posted a sub-cent
amount. The tests now do. **A suite that only ever exercises round numbers is not
testing money.**

## End-to-end checks

Two scripts drive a real build rather than a mock, and both refuse to run if
something is already holding the port — a smoke test that silently passes against
a stale binary is the worst failure mode there is.

- `pnpm smoke` — 18 checks: envelopes, auth, a full trade round trip, the ledger,
  a resting order placed, listed, refused on the wrong side and cancelled, the
  refresh cookie's attributes, body absence, foreign-origin refusal and
  revocation on logout, two-factor enrolment through to a refused replay, session
  listing and cross-user revocation, the login rate limiter, a permission
  refusal driven over real HTTP by demoting a user and logging in again, and a
  deposit started, left uncredited, and refused when its own payer tries to
  confirm it, and an identity document uploaded as bytes, a fake refused by its
  bytes, an oversized one refused by the parser, and a submission that will not
  verify anybody, and a withdrawal refused at the identity gate with nothing
  debited and every finance route shut to a trader, and an API key minted with
  the password, shown once, accepted where it holds a capability, refused where
  it does not or where a person must be, and dead when revoked. The withdrawal
  and key checks throw rather than skipping if the login limiter is already
  spent — a skip there would hide the whole path.
- `pnpm smoke:ws` — 8 checks: quote and candle streaming, gapless sequencing,
  private-channel refusal, cross-account isolation.
- `pnpm smoke:web` — 69 checks across 24 routes, in a real browser: every screen
  signed into, landed on, and read for console errors, plus checks about
  content — that the roles screen shows real grants, that the wallet page
  offers the deposit method this deployment actually has, and that a key
  minted from the security page is shown once and never again. Set
  `PLAYWRIGHT_CHROMIUM_PATH` where Chromium is provisioned outside Playwright's
  own download.
- `pnpm pentest` — 59 attacks attempted against the compiled binary; an attack
  that succeeds fails the run. It was itself tested by breaking the API four
  times to see whether the probes noticed — two did not, and both gaps are now
  closed. Three of the attacks aim at the money path: confirming your own
  deposit, crediting one with an unsigned webhook, and reading another person's
  payments. Each of those refuses to run blind — if the setup step cannot even
  start a payment they throw, because a probe that passes without testing
  anything is worse than no probe. See
  [penetration-checklist.md](./penetration-checklist.md).
- `pnpm soak` — a steady, modest rate held for ten minutes (or
  `SOAK_MINUTES=120`), sampling memory, event-loop lag, handles, database
  backends and per-window latency, watching sequence continuity throughout, and
  ending by summing every account's ledger against its balance. Memory is judged
  by the _slope_ and the _fit_ of its trend, not by a before-and-after: a leak
  climbs, it does not double, and V8's sawtooth produces a confident gradient
  that means nothing. See [soak.md](./soak.md).
- `pnpm restore:rehearse` — dumps the database, restores it into an empty one,
  runs migrations, compares the two by _value_ rather than by row count, and runs
  the real reconciliation engine over the copy. A backup nobody has restored is a
  hypothesis. See [backup-restore.md](./backup-restore.md).

`scripts/declared-dependencies.test.ts` reads every bare import in `apps/api`
and `apps/worker` and requires each to be in that application's own
`package.json`. The workspace hoists, so an import of a transitive dependency
resolves on a developer's machine; pnpm's strict layout in the production image
does not, and the phase 6 API crash-looped on `Cannot find module 'express'`
with every test green. Verified by removing `express` from the manifest and
watching it name the three files that import it.

`background-scope.test.ts` is the equivalent pass over a different blind spot:
anything that runs because _time passed_ rather than because somebody asked. Every
test in this suite drives a service from inside a tenant scope the harness has
already entered, so none of them can see that a timer has no scope at all — which
is how six background paths, stop-loss firing among them, went on failing in
production while every test passed. See [multi-tenancy.md](./multi-tenancy.md) §6a.

`concurrency.test.ts` is the deliberate pass over races nobody had gone looking
for, built around one question: which pair of simultaneous requests could create
money? It found that two orders arriving together could spend the same free
margin twice, because risk was evaluated before the transaction opened rather
than under the account lock. See [final-audit.md](./final-audit.md).

Two integration suites carry the isolation guarantees:
`account-access.test.ts` has one case per caller-scoped operation, so a new
operation that forgets to authorise is caught rather than merely uncovered, and
`master-accounts.test.ts` attacks delegated access from the outside — a real
master, a real account, a real id, and no link.

The rendered terminal is verified by driving a real browser (Playwright) against
a running stack: register, open a position, watch floating P&L move, close it,
and read the trade row back.

## Load

`pnpm load` reports **two** latency figures, and the difference between them is
the difference between "orders are slow" and "this box served every order it was
handed at once".

_Service time, unloaded_ is five orders placed one after another: what a trader
actually experiences. _Round trip under burst_ is 120 orders fired
simultaneously, where each one's round trip includes waiting for the queue in
front of it.

They were one figure until a run reported `p50 2005ms` and the number was chased
as a regression. It was not one: an order is served in ~43ms, and 2005ms was how
long 120 simultaneous orders took to drain at ~58/s. A reader seeing one number
would reasonably have concluded that placing an order takes two seconds — wrong
by a factor of forty. **A metric that misleads is worse than no metric**, which
is the same rule applied to reconciliation checks that cannot fire and integrity
detectors that flag everything.

`pnpm load` drives concurrent sockets, concurrent orders and the live feed
against a real build, and reports what it measured. It fails only on
correctness — sequence gaps, socket errors, rejected orders — because a latency
threshold that passes here and fails on a busy CI runner teaches nobody
anything.

It has already earned its place. The first run reported eight of ten
simultaneous orders on one account failing as `INTERNAL_ERROR`; the cause was a
PostgreSQL deadlock between the share lock a foreign key takes on the account row
and the exclusive lock the ledger takes on the same row. Fixing the lock order
took p50 order latency from 3.4s to 0.3s and the failures to zero. See
docs/database.md.

## Planned

| Phase | Adds                                                      |
| ----- | --------------------------------------------------------- |
| 9     | Chart integration against the licensed library            |
| 10    | Pending orders; account snapshots                         |
| 11    | Cookie-based sessions and CSRF                            |
| 12    | Load: concurrent sockets, high tick rate, high order rate |

## Coverage

Thresholds start at 70% across the domain packages and ratchet up as phases land.
Coverage is measured on `packages/*/src` — the code where a wrong answer costs
money — not on wiring.
