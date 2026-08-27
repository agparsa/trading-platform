# Testing

This is a financial system. Tests are not a quality gate bolted on afterwards;
the formulas were written against them.

```
pnpm test              # 294 tests (97 of them integration, opt-in)
pnpm db:test:prepare   # create + migrate the integration test database
pnpm test:coverage     # thresholds enforced
pnpm verify            # lint → typecheck → test → build
pnpm check:schema      # no floating-point columns exist
pnpm smoke             # boots the built API and drives a full trade round trip
pnpm smoke:ws          # boots it again and drives a real Socket.IO client
```

Integration tests run against a real PostgreSQL database named by
`TEST_DATABASE_URL`, and skip themselves when it is unset — so a clean checkout
gets a green `pnpm verify` with no extra setup, and `pnpm test` still works
offline. Enable them with `pnpm db:test:prepare`, which creates and migrates a
separate database and prints the line to uncomment in `.env`. They use a real database on purpose: row locks, unique
constraints and transaction boundaries are exactly what they check, and a mocked
`FOR UPDATE` proves nothing.

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

| Guard                           | Broken by                                | Result                           |
| ------------------------------- | ---------------------------------------- | -------------------------------- |
| Ledger row lock                 | removing `FOR UPDATE`                    | 10 deposits produced 1200        |
| Close claim (`OPEN → CLOSING`)  | removing the state guard                 | duplicate trade rows             |
| WebSocket account filter        | removing one `if`                        | Bob received Alice's frames      |
| Candle/quote filter separation  | sharing one symbol set                   | watchlist stopped updating       |
| Candle subscription replacement | accumulating instead of replacing        | four streams for one chart       |
| Entry-commission apportionment  | dividing by remaining instead of initial | 12.10 charged where 7.00 was     |
| Round-trip `netPnl`             | dropping the entry leg                   | report no longer matched balance |
| Single entry-commission posting | re-posting the entry leg at close        | 21.00 charged where 14.00 was    |
| Permission guard refusal        | short-circuiting the role check          | 5 of 8 guard tests failed        |
| Permission metadata key         | renaming it in the decorator only        | 6 of 8 guard tests failed        |
| Permission `and` semantics      | `every` becoming `some`                  | catalogue and guard tests failed |
| Global guard registration       | deleting the `APP_GUARD` provider        | coverage test failed             |
| Account ownership check         | removing it from the resolver            | 5 of 7 isolation tests failed    |
| One refusal for "not yours"     | giving it its own error code             | 3 of 7 failed                    |
| Resolver's caller transaction   | ignoring the client it was handed        | 1 of 7 failed                    |
| A service calling the resolver  | dropping the call in `positions.list`    | 1 of 7 failed                    |
| Master link's owning master     | not checking whose link it is            | 2 of 12 master tests failed      |
| Link revocation                 | dropping the status predicate            | 2 of 12 failed                   |
| Delegation ceiling, on read     | trusting the stored capability list      | 1 of 12 failed                   |
| Delegation ceiling, on grant    | accepting any capability                 | 1 of 12 failed                   |
| Socket's link filter            | not checking whose link it is            | 1 of 12 failed _(see below)_     |
| Socket's revocation filter      | dropping the status predicate            | 1 of 12 failed                   |

Two of those are worth remembering.

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

## End-to-end checks

Two scripts drive a real build rather than a mock, and both refuse to run if
something is already holding the port — a smoke test that silently passes against
a stale binary is the worst failure mode there is.

- `pnpm smoke` — 10 checks: envelopes, auth, a full trade round trip, the ledger,
  a resting order placed, listed, refused on the wrong side and cancelled, the
  refresh cookie's attributes, body absence, foreign-origin refusal and
  revocation on logout, and a permission refusal driven over real HTTP by
  demoting a user and logging in again.
- `pnpm smoke:ws` — 8 checks: quote and candle streaming, gapless sequencing,
  private-channel refusal, cross-account isolation.

Two integration suites carry the isolation guarantees:
`account-access.test.ts` has one case per caller-scoped operation, so a new
operation that forgets to authorise is caught rather than merely uncovered, and
`master-accounts.test.ts` attacks delegated access from the outside — a real
master, a real account, a real id, and no link.

The rendered terminal is verified by driving a real browser (Playwright) against
a running stack: register, open a position, watch floating P&L move, close it,
and read the trade row back.

## Load

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
