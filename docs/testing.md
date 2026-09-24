# Testing

This is a financial system. Tests are not a quality gate bolted on afterwards;
the formulas were written against them.

```
pnpm test              # 761 tests (integration ones opt-in)
pnpm db:test:prepare   # create + migrate the integration test database, and its roles
pnpm db:roles          # create the unprivileged role row-level security constrains
pnpm test:coverage     # thresholds enforced
pnpm verify            # lint → format → typecheck → inventory → schema → test → build
pnpm check:schema      # no floating-point columns exist
pnpm smoke             # boots the built API and drives a full trade round trip
pnpm smoke:ws          # boots it again and drives a real Socket.IO client
pnpm smoke:web         # boots the API and the web app and opens every screen
pnpm smoke:contracts   # boots the API and worker; checks every client's reading of every answer
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

These scripts drive a real build rather than a mock, and each refuses to run if
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
- `pnpm smoke:web` — 174 checks across all 35 routes, in a real browser: every screen
  signed into, landed on, and read for console errors, plus checks about
  content — that the roles screen shows real grants, that the wallet page
  offers the deposit method this deployment actually has, and that a key
  minted from the security page is shown once and never again. Set
  `PLAYWRIGHT_CHROMIUM_PATH` where Chromium is provisioned outside Playwright's
  own download.
- `pnpm smoke:contracts` — every typed call the web app, the phone and the
  chart package make (`api.get<T>(…)` and its siblings, read by the TypeScript
  compiler), made against the compiled API and worker with the query keys the
  call site sends, and each answer checked **by the compiler** against the `T`
  the client reads it as: the answer is turned into a type whose every leaf is
  its literal value, and appended — in memory — to the client's own file, under
  its own tsconfig, as an assignment to `T`. A field the client requires and
  the server omits, a string where it reads a number, `'LONG'` where it reads
  `'BUY' | 'SELL'`, a bad row twenty rows down: each is a compile error on a
  line nobody wrote. Extra fields are allowed. The setup gives the API
  something to say — an open position, a closed trade, a resting order, a
  payment settled, a withdrawal paid, identity documents reviewed, a venue
  connection, a webhook, a master account — and every call is either checked
  or listed in `SKIPPED` with its reason; an empty list counts as unchecked
  unless `MAY_BE_EMPTY` says why.

  **Why it exists.** `api.get<T>` is a cast. The build believes `T`, and a
  field the server never sends is `undefined` at run time. Its first run found
  three screens reading answers the API has never given: the phone's positions
  tab asked for `/positions` without the account the server requires and was
  refused on every open; the phone's home screen read `realizedPnl`,
  `commission` and `swap`, which account state does not carry, and showed three
  dashes to everybody; and the console's overview read `trading.halted` where
  the API sends `trading.state` — it said "Open" while trading was halted, and
  its only button halted again, so the platform could not be resumed from the
  console. The kill-switch type now lives in `@tp/shared-types` for both
  sides, and `smoke:web` presses the switch both ways.
  `response-contracts.test.ts` proves the reader and the comparer without a
  running API, and that the smoke run accounts for every typed call.

  **Socket frames too.** The run holds the trader's socket open throughout and
  keeps one frame per payload shape of every event. Each place a client reads
  a frame — the handler's envelope type, `frame.data as T` in the `case` for
  an event, a field read by name — is found by the compiler and checked
  against the frames that came (193 answers and frames in all). Its first run
  found the server sending `{ balance, cause }` as `account.updated` after
  every close, and the phone reading the frame's time as `at`, which the server
  calls `timestamp`. Events it cannot provoke (`order.rejected`,
  `risk.updated`) are listed in `FRAMES_NOT_SEEN` with the reason.

- `pnpm pentest` — 63 attacks attempted against the compiled binary; an attack
  that succeeds fails the run.

  **It is tested by breaking what it defends.** Four defences were removed the
  first time; two were not noticed, and both gaps were closed. Seven more were
  removed in September 2026, and the one that got through is the one worth
  recording: **break-glass being read-only** — the single check that makes a
  support session unable to write as the customer — was deleted from a compiled
  build and all sixty-two attacks still passed. The probe existed and asserted a
  403 on a request that answers 403 regardless, because an administrator cannot
  place an order at all. The same pass found three probes wrapping their setup
  in `if (status === 201)`: a failed precondition skipped every assertion inside
  while the line still printed `refused`, and all three had been attacking
  nothing since the seeded roles stopped giving ADMIN `api_keys.manage`. A probe
  that cannot fail is worse than a missing one, because it occupies the place
  where somebody would otherwise have noticed.

  Three of the attacks aim at the money path: confirming your own deposit,
  crediting one with an unsigned webhook, and reading another person's
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
- `pnpm chaos` — failure injection (§75): Postgres and Redis behind a proxy that
  adds latency, severs connections or refuses; the API killed mid-burst; the
  feed leader killed. After each, the invariant: ledger equals balance, every
  accepted order filled exactly once, every fill has an idempotency record. It
  found the commit-before-record window on its first timed run. See
  [failure-injection.md](./failure-injection.md).
- `pnpm restore:rehearse` — dumps the database, restores it into an empty one,
  runs migrations, compares the two by _value_ rather than by row count, and runs
  the real reconciliation engine over the copy. A backup nobody has restored is a
  hypothesis. See [backup-restore.md](./backup-restore.md).

  **Run again in September 2026 after a long gap, and it failed three times —
  every one of them the harness.** It blamed the database for a feed that had
  not come back; the repair placed real orders and manufactured the exact
  orphaned-fill defect the invariant exists to catch; the next probe measured a
  gauge that reads "no tick yet" while orders are filling. See
  [failure-injection.md](./failure-injection.md). A harness that writes to the
  system it measures is measuring itself.

### Three harnesses in a row were throwing away their own diagnosis

Running the gates nobody runs turned up the same defect three times, in three
different scripts, and none of it was in the platform:

- **`chaos`** collected every byte each instance printed into `recent`, under a
  comment saying it was kept because _"an INTERNAL_ERROR from the API is only
  debuggable from here"_ — and its boot-timeout path discarded all of it.
- **`load`** went further: `ingest.stdout.on('data', () => undefined)` threw the
  ingest instance's output away _deliberately_, and the ingest instance is the
  first thing the harness waits for. On a boot failure it printed
  `did not become healthy` and pointed at **the serving instance's** log file,
  which at that point had not been written.
- **`load` again**, one layer in: `registerTrader` discarded the response to
  `POST /auth/register` entirely. When registration was refused the login on the
  next line answered `Invalid email or password`, and that is what the run
  reported — a message about credentials for a failure that had nothing to do
  with them, with the real status already gone.

All three now print what the failing component actually said. A harness that
collects a diagnosis and then reports one line is worse than one that collects
nothing, because it looks like there is nothing to find.

### The coverage thresholds had never been evaluated

`vitest.config.ts` has carried coverage thresholds since the beginning, under a
comment promising they would _"ratchet up as phases land"_. They were 70, and
**nothing ever ran them**: `pnpm verify` runs `pnpm test`, CI ran `pnpm test`,
and `pnpm test:coverage` sat in `package.json` and in no pipeline. Four numbers
that nobody had ever compared anything against, reading — to anybody skimming
the config — as a guarantee.

The first coverage run this repository has ever done:

|            | Measured  | Threshold was | Threshold is |
| ---------- | --------- | ------------- | ------------ |
| Statements | **95.5%** | 70            | 92           |
| Lines      | **95.5%** | 70            | 92           |
| Branches   | **90.5%** | 70            | 87           |
| Functions  | **89.3%** | 70            | 85           |

Twenty-five points of headroom on a gate that could not have fired. The new
figures sit below the measured ones with enough room that an honest refactor
does not trip them, and not so much that a package can be gutted quietly.

CI runs `pnpm test:coverage` now, so they are evaluated on every push;
`pnpm verify:coverage` is the same by hand. `scripts/coverage-thresholds.test.ts`
checks the two things that made them meaningless — that a pipeline actually runs
the coverage command, and that the numbers have not been quietly lowered back to
decoration.

The scope stays `packages/*`: pure domain logic, where a missing branch is a
financial rule nobody exercised. The applications are covered by the integration
suite, the browser suite and sixty-three attacks, none of which a line-coverage
number describes usefully.

### Components are rendered now, and for a while they were not

`vitest.config.ts` restricted the web app to pure logic for want of a DOM
environment, so **no component in `apps/web` had a rendering test at all**: the
lib functions a component calls were tested and the component itself was not.
The browser suite renders 33 views and audits every one for accessibility, but
it places its single order over HTTP rather than through the ticket — so a
component that computed the right answer and painted the wrong thing was caught
by nobody.

That was not hypothetical. The order ticket held every risk violation the server
sent and rendered the first.

A component test now looks like this:

```tsx
// @vitest-environment jsdom
```

Per file, not global: jsdom costs about a second to construct and nothing else
here needs one. `esbuild: { jsx: 'automatic' }` gives the same transform Next.js
applies, so a test writes JSX without importing React.

`order-ticket.test.tsx` is the first, and it is the shape to copy. The mocks
stop at the edge — the data hooks and the session — and everything from the
submit handler inward is the real component; the assertion reads the ticket's
own `role="alert"` rather than the page text, because the command log beneath
also carries the reason and a text query would pass on the log alone, which is
the bug rendered somewhere else. Four mutations fail it, including the original
one.

**What is still not covered.** One component of many. The static checks in
`scripts/rejection-surfaces.test.ts` remain, because they reach the mobile
screen and the API shape that a jsdom test of one web component cannot, and
because a cheap check that reads source is worth keeping beside an expensive one
that renders.

One side effect worth recording: v8 instrumentation slows `resetDatabase` —
forty tables truncated and the roles re-seeded between cases — past vitest's
ten-second hook default, and the first coverage run failed twice in
`withdrawals` for reasons that had nothing to do with withdrawals. `hookTimeout`
is 40 seconds now. A gate that only fails when it is measuring itself teaches
people to stop measuring.

### Tests run against source, and for seven packages they did not

`vitest.config.ts` aliases each workspace package to its TypeScript source, with
a comment saying why: _a stale build would otherwise let a test pass against
code that no longer exists._ The list was hand-written, and it covered thirteen
packages out of twenty.

The seven it missed were `crypto-core`, `tenancy`, `payments-core`,
`withdrawals-core`, `kyc-core`, `broker-sdk` and `scheduling-core` — sealing and
key rotation, the firm boundary, money in and money out, identity documents, and
the venue adapters. Every test naming one of those imported a compiled
artefact.

Measured rather than argued. The `scope === undefined` guard in `tenancy` —
layer one of tenant isolation, the throw that stops a query running with no firm
in scope — was removed from the source **without rebuilding the package**, and
all eighteen isolation tests passed. With the alias added, four of them fail at
once. Earlier the same day a mutation to `crypto-core` appeared to survive twice
and was killed the moment the package was rebuilt by hand; that was put down to
the mutation tooling, and it was this.

Nothing had actually diverged: with all twenty aliased, the suite is green. The
exposure was the point — a `dist` a day out of date would have been invisible,
and the packages it was invisible for are the ones holding the money and the
tenant boundary.

`scripts/vitest-aliases.test.ts` now checks the list against the packages
directory in both directions, and that each package publishes the name the alias
uses — a mismatched name means the alias silently does not apply, which is the
same failure wearing a different hat.

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
